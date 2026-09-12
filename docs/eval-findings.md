# hc — defects & weaknesses found while benchmarking on Terminal-Bench 2.0

Compiled 2026-09-09 from the Harbor / Terminal-Bench 2.0 runs (see
[harbor.md](harbor.md)). Source data: an 18-task subset on
`deepseek/deepseek-v4-pro` (baseline + turn-budget-nudge re-runs) plus
per-session traces. The full 89-task run is still pending (DeepSeek balance ran
out mid-run).

Legend — **Status**: `fixed` (landed on branch `harbor-eval-and-timeout-fix`),
`open`, `wontfix / by-design`. **Confidence**: how sure we are the finding is
real and correctly diagnosed.

---

## A. Bugs (provider / loop / CLI plumbing)

### A1. Request timeout leaked → uncaught `TimeoutError` crashed the process — **fixed** (commit `bee6c29`)
- **Evidence:** `filter-js-from-html` trial — `hc.log` ended with
  `DOMException [TimeoutError] ... at node:internal/abort_controller` and
  `triggerUncaughtException(err, true /* fromPromise */)`, exit non-zero,
  Harbor recorded `NonZeroAgentExitCodeError`.
- **Root cause:** `packages/core/src/provider/openai-compat.ts` `request()` armed
  `AbortSignal.timeout(this.cfg.timeoutMs)` (default **600 000 ms**) per attempt
  and never cleared it. On a stream that outlived the timeout (real, under
  Rosetta), the timer fired on a composite signal with no live listener →
  unhandled rejection.
- **Impact:** one slow model call = whole run dies (not a retry, not a graceful
  turn failure).
- **Fix landed:** controlled `deadline()` helper (`AbortController` + `setTimeout`
  cleared on `dispose()`); streaming + non-streaming body reads wrapped so a
  timeout becomes a **retryable `ProviderError('network')`**, an external abort a
  non-retryable `ProviderError('aborted')`; `parseSSE` now receives the
  deadline-aware signal.
- **Confidence:** high (reproduced locally with a stub server; regression tests
  in `openai-compat.test.ts`).

### A2. Silent stream truncation on abort/timeout — **fixed** (same commit)
- **Root cause:** `parseSSE` (`sse.ts:24`) cancels its reader on abort, which
  ends the `for await` **cleanly** rather than throwing. `streamNative` would
  then assemble a `message_end` from the partial text — a truncated "successful"
  completion instead of an error.
- **Fix landed:** post-loop `if (req.signal?.aborted || timeoutSignal.aborted)
  throw normalizeStreamError(...)` in `streamNative`.
- **Confidence:** high (this is exactly what two of the new tests caught before
  the post-loop check was added).

### A3. A non-`ProviderError` escaping the provider crashed the run — **fixed** (`loop.ts`)
- **Root cause:** `loop.ts` `streamTurn` had no try/catch; the call site only
  handled `ProviderError` with `kind === 'aborted'` and re-threw everything else
  up to `main()`.
- **Fix landed:** any non-`ProviderError` escaping the provider ends the run at
  `stopReason: 'error'` (a valid `AgentStopReason`), so `runTurn` returns a
  result the caller can inspect. `ProviderError` still propagates.
- **Confidence:** high.

### A4. No `unhandledRejection` guard in the CLI — **fixed** (`packages/cli/src/index.ts`)
- **Impact:** a stray late rejection printed a raw V8 stack; for
  `--output-format json` that also meant **no parseable JSON on stdout** for a
  scripted caller.
- **Fix landed:** `process.on('unhandledRejection')` → one readable line + exit 1.
- **Confidence:** high.

### A5. `stream-json` output format not implemented — **open** (deferred, known)
- `createSink('stream-json', …)` throws
  `'--output-format stream-json is not implemented yet (deferred to v1.1)'`
  (`packages/cli/src/output.ts`). Not needed for the Harbor adapter (uses `json`)
  but blocks any consumer that wants incremental structured events.

### A6. Mid-stream transient failure loses the whole turn — **fixed** (see [runtime-hardening.md](runtime-hardening.md))
- `request()`'s retry loop wraps only the *initial fetch*. A stall or connection
  drop **mid-SSE-stream** now throws a retryable `ProviderError` (A1), but
  `loop.ts` re-threw `ProviderError` rather than retrying the turn — so one
  transient blip still ended the run.
- **Fix landed:** `AgentLoop.streamTurnWithRetry` re-sends the same request up to
  `maxTurnRetries` (default 2) times on a retryable, non-abort `ProviderError`,
  with the shared exponential backoff (`provider/retry.ts`). Safe because the
  failure precedes any tool execution. Emits a `turn_retry` event (consumers drop
  the failed attempt's partial deltas — `JsonSink`, TUI `EventBuffer`), a
  `provider-retry` warn notice, and a trace `error` with `willRetry: true`.
  Abort during the wait → `aborted`; retries exhausted → the error propagates as
  before. Sub-agents get it for free (same loop).
- **Caveats:** a failed partial stream has no `message_end`, so its tokens are
  not counted in usage. Transport and loop retries nest: against a dead endpoint
  the worst case is ~(1 + `maxRetries`) × (1 + `maxTurnRetries`) fetch attempts
  (~26 s observed with defaults) before the error surfaces.
- **Confidence:** high (unit tests in `loop.test.ts`; verified end-to-end against
  an unreachable endpoint).

### A7. `.env` is loaded relative to `process.cwd()`, not `--cwd` — **open / minor**
- `loadDotEnv(resolvePath(process.cwd(), '.env'))` in `index.ts`. For a headless
  run where the invocation dir ≠ the workspace (`--cwd`), the workspace `.env`
  is ignored and the invocation dir's is used. Surprising for scripted use.
- **Confidence:** high (read the code) — low impact.

---

## B. Observability gaps (headless / benchmark use)

### B1. `--output-format json` produces **zero** stderr until the very end — **fixed** (see [runtime-hardening.md](runtime-hardening.md))
- `JsonSink.notice()` was a no-op and `JsonSink.event()` only accumulated text
  (`output.ts`). During a 40-turn run, `hc.log` stayed empty; nothing was
  observable until the final one-line JSON. We had to reconstruct every run from
  the `.agent/traces/*.jsonl` file instead.
- **Fix landed:** with `json` output, `JsonSink` now streams JSONL progress to
  **stderr** by default (`packages/cli/src/progress.ts`): `notice`,
  `tool_start` (capped input summary), `tool_end` (`is_error`, `output_bytes`,
  capped `error`), `turn_end` (usage + `text_chars`), `turn_retry`,
  `compaction`, `stop`, each with `ts`. Token deltas are not streamed. stdout is
  unchanged (one result object). `--no-progress` opts out. The Harbor adapter
  needs no change — `hc.log` picks it up. The line shapes are meant to be reused
  for `stream-json` (A5).
- **Follow-up fixed (found while verifying):** a run that ended on an uncaught
  error (e.g. retries exhausted) used to print a text error and exit 1 with **no
  JSON result on stdout**. `runOneshot` now catches it, calls the new
  `OutputSink.fail()`, and re-throws (so the stderr message and exit code 1 are
  unchanged). `JsonSink.fail()` writes the usual result object with
  `stop_reason: "error"`, `is_error: true`, an `error: {message, kind?}` field,
  the completed model calls' `turns` / `usage` (tallied from `turn_end`, since
  the run's own result is lost), and drops the dead call's partial text; with
  progress on it also emits a final `{"type":"error"}` line. Harbor trials that
  crash now yield a parseable `hc-result.json`. Not covered: errors *before* a
  sink exists (bad `--model`, missing config) still exit via a plain-text
  `fail()` in `index.ts`.
- **Confidence:** high.

### B2. Exit code doesn't distinguish "solved" / "gave up" / "crashed" — **by-design, but note**
- `hc` exits 0 on normal completion regardless of `is_error` / `stop_reason`.
  Correct for a CLI; for a benchmark harness it means the grader must inspect
  `stop_reason` + the workspace. The Harbor adapter does this, but any other
  eval integration has to know to.

### B3. Trace omits tool *output* and message content — **by-design, but limits post-mortem**
- Traces record `outputBytes` + `isError` but not tool output text or prompts
  (`docs/telemetry.md`). Diagnosing *why* a run rabbit-holed means re-running or
  reading `.agent/sessions/*.jsonl`. Fine as a default; an opt-in verbose trace
  would help eval debugging.

---

## C. Agentic behaviour weaknesses (model + scaffold — the real ceiling)

All observed on `deepseek-v4-pro`; a stronger model masks several of these but
the scaffold does nothing to counteract them.

### C1. No "good enough" / stop criterion — **addressed** (prompt `<finishing>` block + turn-budget nudge)
- **Evidence:** pre-nudge, 4 of the 9 tasks that *passed* still ran to the
  40-turn wall (`cancel-async-tasks`, `count-dataset-tokens`,
  `large-scale-text-editing`, `largest-eigenval`) — polishing / re-verifying past
  done. Cost 2–3× the turns they needed; risk of breaking a working solution on
  the last edit before `max_turns` cuts in.
- **Mitigation landed:** `loop.ts turnBudgetNote()` — past ~60 % of `maxTurns`,
  an ephemeral per-turn note ("turn N of M, converge / commit / this is your
  last turn"). Result on the 9-task slice: 4/9 → 6/9, and the already-passing
  tasks shed ~50 turns / ~$0.65 combined.
- **Fix landed:** a `<finishing>` block in `AGENT_CONVENTIONS` (`prompt.ts`) —
  "reach a working solution, then stop; verify once; make no further tool calls;
  don't re-verify or polish; if stuck, step back or say so". This is a
  system-prompt change, so it **invalidates the eval cassettes** — re-record
  needed (see the note at the end of section C).
- **Still open:** an explicit `finish` tool (some models use an end-of-task
  action more reliably than "stop calling tools"). Deferred — add it if a data
  point shows prompt guidance alone isn't enough.

### C2. Rabbit-holing — goes deeper into one approach instead of re-planning — **partially addressed** (step-back nudge)
- **Evidence:** `break-filter-js-from-html` (endless hand-written XSS variants to
  test its filter), `db-wal-recovery` (spelunking `/proc`, Linux capabilities,
  hand-simulating the SQLite WAL format), `largest-eigenval` (building a C
  extension + ctypes→LAPACK instead of the numpy call), `chess-best-move`
  (downloading piece images from Wikimedia). The turn-budget nudge helps when
  the run is *thrashing across many small approaches* (break-filter flipped to
  pass) but **not** when it's committed to one wrong deep approach —
  `largest-eigenval` regressed under the nudge because "commit to your solution"
  entrenched the C-extension path.
- **Fix landed:** `loop.ts stallNote()` — after 3 consecutive turns whose every
  tool call errored, an ephemeral note: "stop retrying variations of the same
  command; reconsider from the top; what's the simplest thing that would pass;
  if blocked, say so and stop". Cassette-safe (ephemeral trailing-message
  injection, same as the turn-budget nudge; the eval fixtures don't trigger it).
  Also covers most of **C3**.
- **Still open:** this catches the *all-tool-calls-failed* stall, not the
  "making tool calls that succeed but aren't progressing" one (e.g.
  `largest-eigenval` writing bench1..bench9). That needs a progress signal
  (turns since the deliverable was last touched), which is harder to define
  generically.
- **Confidence:** high (consistent across 4+ traces).

### C3. Blind tool retries — **partially addressed** (step-back nudge, see C2)
- **Evidence:** 5–10 tool errors per long run, frequently the *same* command
  with a tweaked flag (`cancel-async-tasks` t31/t32/t35 — three `grep` variants
  on the same file; `largest-eigenval` t38/t39 — repeated failing `gcc`/`python`
  invocations).
- **Fix direction:** detect a repeated-failing-command pattern and surface it
  ("this command has failed 3× — try a different approach"), or feed the model a
  short "recent failures" digest.
- **Confidence:** high.

### C4. Scratch-file sprawl, no cleanup — **addressed (prompt), effect unmeasured**
- **Evidence:** `largest-eigenval` wrote `bench.py`, `bench2.py` … `bench9.py`,
  `debug_inv.py`, `test_*.py` — a **new** file per micro-experiment rather than
  iterating one. Context ratio was only 0.03–0.08 (936k window), so this is not
  memory loss — it's a behaviour. The scratch files also pollute the workspace
  the verifier inspects (didn't cause a failure in the subset, but it's a
  latent risk).
- **Fix landed (2026-09-12):** a `<working_style>` block in `AGENT_CONVENTIONS`
  (`prompt.ts`) — "reuse one scratch file across attempts instead of creating a
  new one per attempt (...); remove any scratch file you created that isn't
  part of what the task asked for."
- **Not yet measured:** none of the 5 local eval fixtures exercise
  multi-attempt experimentation, so the local suite passing 5/5 confirms no
  regression, not that this actually reduces sprawl. Needs a Harbor re-run on
  `largest-eigenval` (or a similar task) to know if it helps in practice.
- **Confidence:** high that the behavior is real; unconfirmed that this fix works.

### C5. Late commitment to the deliverable — **addressed (prompt), effect unmeasured**
- **Evidence:** `largest-eigenval` — `eigen.py` (the actual deliverable) edited
  **once, at turn 35/40**. `count-dataset-tokens` — `answer.txt` first written at
  **turn 37/40**. Exploration is front-loaded, implementation back-loaded, so the
  run gets cut off mid-implementation.
- **Fix landed (2026-09-12):** the same `<working_style>` block — "get a rough
  version of the actual deliverable in place early — within roughly the first
  third of the work — then spend the rest of the time refining it."
- **Not yet measured:** same caveat as C4 — the local suite doesn't reproduce
  this failure mode (its tasks are short enough that front-loaded exploration
  isn't costly), so this needs a Harbor re-run on `count-dataset-tokens` /
  `largest-eigenval` to confirm it actually shifts when the deliverable gets
  touched.

### C6. Over-engineering — no bias toward the simplest passing solution — **prompt fix landed, unverified**
- **Evidence:** `largest-eigenval` chose a C extension over the one-line numpy
  call. Adding "fall back to the simplest implementation that could pass" to the
  ≥80 % budget tier (commit `6bd3055`) did **not** recover it on a re-run.
- **Diagnosis of why that attempt failed:** wrong timing and wrong kind of
  instruction. The 80%-budget nudge only fires after the model is already deep
  into the complex approach — sunk cost by then, a late reminder can't undo it.
  It was also phrased as an abstract preference ("prefer simplest"), which a
  model can always rationalize past ("this case really does need it"), rather
  than a concrete sequencing rule it has to follow before committing to
  anything.
- **Fix landed (2026-09-12):** extended the `<working_style>` block in
  `AGENT_CONVENTIONS` (`prompt.ts`) with an upfront rule, not a late reminder:
  "before implementing anything non-trivial, check whether a standard library
  call or a few lines of straightforward code already does what's needed — try
  that first and verify it; only reach for something more elaborate once the
  simple version has demonstrably fallen short." This targets the *timing*
  problem (before the model commits, not after) and the *framing* problem (a
  step to follow, not a preference to weigh).
- **Not yet verified.** This is a second attempt at the same failure mode the
  first attempt didn't fix — no reason yet to believe it works better beyond
  the timing/framing argument above. Needs a Harbor re-run on `largest-eigenval`
  specifically before this can be marked done rather than "landed, unverified."
  Local eval cassettes are intentionally **not** re-recorded yet (this second
  `AGENT_CONVENTIONS` change since the C4/C5 landing again invalidates their
  hashed request key) — left stale until the next real-model validation pass,
  per the user's call to hold off on further spend for now. Expect
  `evals/src/harness.test.ts`'s two replay-based tests to fail until then; this
  is the known, accepted state, not a regression.

### C7. Fussing over trivial details near the wall — **open (symptom of C1)**
- **Evidence:** `count-dataset-tokens` spent its last 3 turns (t38–40) on whether
  `answer.txt` should have a trailing newline (`xxd` → `od -An -t x1` → rewrite).

---

> **Eval cassettes re-recorded (2026-09-12), twice.** First after the C1
> `<finishing>` prompt block, then again after the C4/C5 `<working_style>` block
> — both change `AGENT_CONVENTIONS`, part of the hashed request key. Current
> cassettes reflect the full prompt including both blocks:
> `deepseek/deepseek-v4-flash`, 5/5 tasks pass@k, 5/5 pass@1 (avg cost
> $0.0018–$0.0040/task). Re-record with `pnpm eval --record --update-baseline`
> whenever the system prompt or request-key scrubbing changes materially.

---

## D. Integration / environment observations (not hc bugs)

### D1. No native Anthropic API — Claude models only via OpenRouter / a proxy — **open (design)**
- `packages/core/src/provider/router.ts` — every provider goes through the
  OpenAI Chat Completions adapter; there is no `anthropic` provider. To run
  Sonnet/Opus you go through `openrouter/anthropic/...` or an OpenAI-compat
  proxy. Costs ~1–3 points of capability (translation nuances, thinking
  passthrough) and adds a dependency. **Biggest blocker if the goal is to
  benchmark hc with — or against — Claude models.**

### D2. `hc` is not published — external evals need the esbuild bundle — **handled**
- `scripts/bundle-hc.mjs` → `dist-bundle/hc.mjs`. Works, but any new eval
  integration has to know to build it first.

### D3. Turn-budget nudge — known regression on perf-optimisation tasks — **open**
- `largest-eigenval` flipped pass→fail under the nudge (see C1/C6). Net effect on
  the 9-task slice was still +2, but this is a real trade-off to revisit when C1
  gets a proper fix.

### D4. Default `timeoutMs` 600 000 ms is very generous — **open / minor**
- Under Rosetta a genuine 10-minute stream is reachable, which is how A1 first
  fired. The loop-level retry (A6) has landed, so a timeout now costs a retry
  rather than the run; a lower default (or per-model) is still worth considering.

### D5. Local Docker on Apple Silicon: Rosetta drag — **environmental, affects any local run**
- TB2 images are amd64; under Rosetta emulation: slow `apt`/build steps,
  `EnvironmentStartTimeoutError` (`mteb-leaderboard`, `pytorch-model-recovery`),
  `Docker compose command failed` (`overfull-hbox`), agent wall-clock timeouts.
  ~10–20 % of the heavy tasks fail on infra regardless of hc. Use a cloud
  sandbox (`--env daytona/modal/...`) or `--agent-timeout-multiplier` for a
  clean capability number.

---

## Priority for "对症下药"

Roughly, highest leverage first:

1. ✅ **C1 done-detection** (`<finishing>` prompt block) + ✅ **C2/C3 step-back nudge** — landed, cassettes re-recorded (2026-09-12, local 5/5 suite still passes). These are most of the agentic gap and lift *every* model's score. *Next Harbor measurement will tell us how much.*
2. ✅ **C4 scratch-file discipline** + ✅ **C5 late commitment** (`<working_style>` prompt block, 2026-09-12) — landed, cassettes re-recorded, local suite unaffected. **Effect on the actual failure modes (largest-eigenval, count-dataset-tokens) is not yet measured** — the local fixture tasks don't reproduce them; needs a Harbor re-run to confirm. The remaining half of C2 (a real progress signal, not just all-failed) is still open.
3. ✅ **A6 loop-level retry of retryable ProviderErrors** — removes the "one transient blip ends the run" failure.
4. ✅ **B1 headless observability** — not a capability fix, but makes every future eval debuggable without re-running.
5. **D1 native Anthropic** (or a blessed OpenRouter path) — required before any Claude-model benchmarking.
6. ✅ **C6 simplicity bias** (`<working_style>` upfront try-simple-first rule, 2026-09-12) / **D3 nudge regression** — landed as a second attempt, deliberately different from the first (see C6 above: earlier timing, a concrete rule instead of an abstract preference). **Unverified** — local cassettes intentionally left un-re-recorded for now; needs a Harbor re-run on `largest-eigenval` to know if it actually works, given the first attempt at this same failure mode didn't.

> See also [runtime-learnings.md](runtime-learnings.md) (2026-09-10): a comparison with Codex / opencode /
> hermes-agent that found four more runtime defects (tool calls reordered within a turn — reproduced;
> `max_tokens` truncation treated as `end_turn`; no reactive compaction on `context_length`; unrepaired
> dangling tool calls on `--resume`) and concrete designs for the open half of C2/C3 (signature-level
> tool-loop guardrails) and for sub-agents that hit `max_turns` (a final tool-less summary turn).
