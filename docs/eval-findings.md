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

### A6. Mid-stream transient failure loses the whole turn — **open**
- `request()`'s retry loop wraps only the *initial fetch*. A stall or connection
  drop **mid-SSE-stream** now throws a retryable `ProviderError` (A1), but
  `loop.ts` re-throws `ProviderError` rather than retrying the turn — so one
  transient blip still ends the run.
- **Fix direction:** in `loop.ts`, retry the turn (bounded, with backoff) when
  `streamTurn` throws a `ProviderError` with `retryable === true`, before
  falling through to the error stop.
- **Confidence:** medium (logic is clear from the code; not yet observed to bite
  post-A1, but the pre-A1 crashes were this path).

### A7. `.env` is loaded relative to `process.cwd()`, not `--cwd` — **open / minor**
- `loadDotEnv(resolvePath(process.cwd(), '.env'))` in `index.ts`. For a headless
  run where the invocation dir ≠ the workspace (`--cwd`), the workspace `.env`
  is ignored and the invocation dir's is used. Surprising for scripted use.
- **Confidence:** high (read the code) — low impact.

---

## B. Observability gaps (headless / benchmark use)

### B1. `--output-format json` produces **zero** stderr until the very end — **open**
- `JsonSink.notice()` is a no-op and `JsonSink.event()` only accumulates text
  (`output.ts`). During a 40-turn run, `hc.log` stays empty; nothing is
  observable until the final one-line JSON. We had to reconstruct every run from
  the `.agent/traces/*.jsonl` file instead.
- **Fix direction:** with `json` output, still stream structured progress
  (tool-call starts/ends, notices) to **stderr** as JSONL, or honour
  `--verbose`. Keeps stdout clean (one result object) while making a headless
  run debuggable.
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

### C4. Scratch-file sprawl, no cleanup — **open**
- **Evidence:** `largest-eigenval` wrote `bench.py`, `bench2.py` … `bench9.py`,
  `debug_inv.py`, `test_*.py` — a **new** file per micro-experiment rather than
  iterating one. Context ratio was only 0.03–0.08 (936k window), so this is not
  memory loss — it's a behaviour. The scratch files also pollute the workspace
  the verifier inspects (didn't cause a failure in the subset, but it's a
  latent risk).
- **Fix direction:** prompt guidance to reuse a single scratch file / a
  `/tmp` scratch convention; optionally a post-run cleanup of files the agent
  created outside the task's expected outputs.
- **Confidence:** high.

### C5. Late commitment to the deliverable — **open (related to C1/C2)**
- **Evidence:** `largest-eigenval` — `eigen.py` (the actual deliverable) edited
  **once, at turn 35/40**. `count-dataset-tokens` — `answer.txt` first written at
  **turn 37/40**. Exploration is front-loaded, implementation back-loaded, so the
  run gets cut off mid-implementation.
- **Fix direction:** encourage an early "make it work, then make it good" pass —
  a rough solution to the real target file within the first third, then iterate.

### C6. Over-engineering — no bias toward the simplest passing solution — **open**
- **Evidence:** `largest-eigenval` chose a C extension over the one-line numpy
  call. Adding "fall back to the simplest implementation that could pass" to the
  ≥80 % budget tier (commit `6bd3055`) did **not** recover it on a re-run.
- **Fix direction:** stronger, earlier framing ("prefer the simplest correct
  approach; only optimise if tests pass and time remains"), or a scaffold that
  requires a passing baseline before optimisation.

### C7. Fussing over trivial details near the wall — **open (symptom of C1)**
- **Evidence:** `count-dataset-tokens` spent its last 3 turns (t38–40) on whether
  `answer.txt` should have a trailing newline (`xxd` → `od -An -t x1` → rewrite).

---

> **Eval cassettes need re-recording.** The C1 `<finishing>` prompt block changes
> `AGENT_CONVENTIONS`, which is part of the hashed request key, so all 5 fixture
> cassettes miss on replay. Until re-recorded, `pnpm eval` fails and
> `evals/src/harness.test.ts`'s two replay tests fail. Fix once a DeepSeek
> balance is available:
> ```
> pnpm eval --record --update-baseline    # ~$0.10, hits the real model
> pnpm eval                               # confirm green
> ```
> The step-back nudge (C2/C3) is cassette-safe on its own; only the prompt
> change forces the re-record.

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
  fired. Consider a lower default (or per-model) plus the loop-level retry (A6).

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

1. ✅ **C1 done-detection** (`<finishing>` prompt block) + ✅ **C2/C3 step-back nudge** — landed; needs a cassette re-record. These are most of the agentic gap and lift *every* model's score. *Next measurement will tell us how much.*
2. **C4 scratch-file discipline** + the remaining half of C2 (progress signal, not just all-failed) — cheap prompt/scaffold changes.
3. **A6 loop-level retry of retryable ProviderErrors** — removes the "one transient blip ends the run" failure.
4. **B1 headless observability** — not a capability fix, but makes every future eval debuggable without re-running.
5. **D1 native Anthropic** (or a blessed OpenRouter path) — required before any Claude-model benchmarking.
6. **C6 simplicity bias** / **D3 nudge regression** — the `<finishing>` block now says "prefer the simplest approach"; re-check `largest-eigenval` on the next run.
