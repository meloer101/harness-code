# Agent Harness Engineering: Taxonomy + Gap Map for `harness-code` (hc)

This document decomposes "agent harness engineering" into a taxonomy of parts, maps every concrete gap already documented elsewhere in this repo onto that taxonomy, and lays out a prioritized upgrade roadmap. It is an analysis/planning artifact, not a changelog — none of the gaps below are fixed by this document.

Sources: `docs/eval-findings.md`, `docs/runtime-learnings.md`, `docs/web-frontend.md`, `docs/web.md`, `docs/eval.md`, `docs/grep-output-blowup.md`, `docs/telemetry.md`, `docs/PLAN.md`, `docs/PHASE-3.5.md`, `docs/PHASE-9.md`, `docs/runtime-hardening.md`, plus direct inspection of `packages/core`, `packages/protocol`, `packages/server`, `packages/web`, `evals/`.

## 0. Verification note on gap #12

`docs/web-frontend.md` lists as an open TODO: *edit's permission-approval preview shows only the path, not the diff content.*

Checked against code:
- `packages/web/src/components/tools/registry.tsx` — `toolPreview('edit', …)` renders `EditPreviewPanel` with `path`, `oldString`, `newString`, `replaceAll` — the full diff, not just the path.
- `packages/web/src/components/tools/diffPanels.tsx` — `EditPreviewPanel` is a real, implemented component (not a stub).
- `packages/web/src/components/PendingDock.tsx` — `toolPreview` is wired into the live ask/permission dock (`pendingAsk.toolName`, `pendingAsk.input`), not dead code.
- A render test exercises `toolPreview('edit', {oldString, newString, …})`.

**Conclusion: this gap was already fixed well before this session — the pending working-tree change is a refactor, and that refactor was actually a half-finished regression until this session fixed it.** Pinning it down precisely (2026-09-12): the diff-preview feature itself landed in commit `f570301` ("markdown, lazy highlighting, per-tool cards, diff previews — M5 batch 3"), with `render.test.tsx`'s `previews an edit ask as a diff` test already committed and passing at `HEAD`. The doc's TODO line (in `docs/web-frontend.md`, from an earlier smoke-test note) was simply never deleted across the three commits since. The untracked `packages/web/src/components/tools/diffPanels.tsx` plus the uncommitted edits to `registry.tsx`/`Markdown.tsx`/`MarkdownBody.tsx` are a **code-split refactor**: moving the diff-rendering and markdown-rendering logic behind `React.lazy`/`Suspense` so `react-markdown`/`diff` stay out of the main bundle. This refactor was structurally correct, but **`render.test.tsx` (already committed, untouched by the refactor) was never updated for it** — its assertions ran synchronously against the `Suspense` fallback ("Loading diff…") instead of the resolved content, so 4 of 8 tests in that file were actually failing in the working tree before this session. Fixed in this session by adding `await screen.findByText(...)` calls at the right points in `render.test.tsx` so assertions wait for the lazy chunk to resolve; all 8 tests pass now, and the full `packages/web` suite (63 tests) is green. (Also correcting an earlier mislabel in this analysis: the untracked `packages/server/src/registry.test.ts` is unrelated — it tests the server-side `SessionRegistry`/session-multiplexing code, not anything web/edit-preview related, and is part of a separate, larger pending server-side batch left out of scope here.) Committed in this session: `docs/web-frontend.md` (corrected TODO), `registry.tsx`, `diffPanels.tsx`, `Markdown.tsx`, `MarkdownBody.tsx`, `render.test.tsx`.

---

## 1. Taxonomy of Agent Harness Engineering

Nine categories, chosen to (a) partition cleanly — every subsystem has one clear home, (b) generalize past this repo, (c) anchor concretely in `hc`'s actual files.

| # | Category | What it owns | Anchor in `hc` |
|---|---|---|---|
| A | **Model / Provider Layer** | Talking to LLM backends: request/response translation, streaming, tool-call encoding, error taxonomy, provider-specific quirks (thinking blocks, finish reasons, prompt caching) | OpenAI-compatible layer, OpenRouter proxy, `packages/core` provider abstraction |
| B | **Orchestration Loop & Turn Management** | The control loop that drives a session forward: stream→collect→gate→execute→append→repeat; turn/cost/token budget accounting; retries; convergence nudges | `packages/core/src/agent/loop.ts` (`AgentLoop`), `AgentEvent` vocabulary |
| C | **Tool System & Execution** | Tool definitions, execution semantics (parallel/sequential, concurrency safety), result formatting, output-size discipline | bash/read/write/edit/grep/glob/todo/task/exit_plan_mode, `packages/core/src/mcp/hub.ts` |
| D | **Permission, Safety & Sandboxing** | Authorization model (modes, allow/ask/deny rules), static/dynamic inspection of risky calls, OS-level containment | `PermissionEngine`, `bash-ast.ts`, `macos-sandbox.ts` |
| E | **Context Engineering** | What the model sees on each turn: budget thresholds, compaction, memory/summarization, ephemeral steering (nudges) | compaction logic in `loop.ts`, warn/compact/stop thresholds (0.8/0.92/0.95), nudge injection at 60%/80% of turn budget |
| F | **Protocol & State Sync** | The wire contract and multi-surface state-reconstruction problem: RPC schema, event stream, client-side folding, transport reliability across surfaces (web, TUI) | `packages/protocol` (`methods.ts`, `frames.ts`, `events.ts`, `fold/`), `SessionHost` multiplexing, `SessionModel`/`SessionSync` in web |
| G | **Observability & Evaluation** | Telemetry, deterministic regression testing, real-model benchmarking, ablation measurement | `evals/` cassette harness + `baseline.json`, Harbor/TB2 integration, `docs/telemetry.md` |
| H | **Agentic Behavior Quality** | The "soft" capability ceiling that isn't a bug in any one subsystem: task focus, simplicity bias, convergence discipline, judgment near resource limits | `docs/eval-findings.md` C4–C7 comparative study |
| I | **Operational Hardening** | Surviving the real world: crashes, kills, resumes, malformed/missing config, resource blowups, headless/automation compatibility | `--resume`, `SessionRecorder` persistence, headless JSON progress streaming, grep output caps |

**Boundary notes:**
- **A vs B**: A owns "how do we talk to the provider and interpret what it says" (including whether a response was truncated); B owns "what do we do next given that." Truncation *detection* is A; the loop's *reaction* to a truncation signal is B.
- **E vs H**: E is the mechanism (nudge injection, thresholds); H is whether that mechanism actually produces better agent judgment. A nudge can be mechanically correct (E) and still net-regress behavior (H).
- **G vs H**: G is the measurement apparatus; H is what the measurements are about. Without G being trustworthy, H conclusions are unreliable — this drives the sequencing in §3.

---

## 2. Gap-to-Category Mapping

| # | Gap | Primary | Secondary | Severity | Effort | Remedy |
|---|---|---|---|---|---|---|
| 1 | ~~Tool-call reordering within a turn~~ → **RESOLVED 2026-09-12**, see note | **B** Orchestration Loop | F | Was Critical, now closed | Done (M) | **Re-verified against code, not just docs**: the execution-order bug the source doc described (`[edit, read]` actually running as `read, edit`) was *already fixed* — `runToolCalls` batches consecutive `concurrencySafe` calls and treats a non-safe call as a barrier, with a passing regression test (`preserves model order: a write barrier runs before a following read`). A narrower, real, previously-untested residual bug remained: within a concurrent batch, `tool_call_end` events and the `recorder`/`trace` calls they drive fired in *completion* order, not the model's *emission* order. Fixed in this session: `loop.ts`'s `runToolCalls` now buffers out-of-order completions (`runBatchInOrder`/`pending`/`drain`) and flushes them strictly in original order; execution stays parallel. New test: `emits tool_call_end in the model's emission order even when a later call finishes first` (`packages/core/src/agent/loop.test.ts`). See `docs/runtime-learnings.md` §1 for the full before/after. |
| 2 | Truncated model output silently treated as complete → **PARTIALLY STALE**, see note | **A** Model/Provider Layer | B (loop's turn_end handling) | Was Critical, now Low (residual only) | Done for the critical part; S remains for the enhancement | **Re-verified against code**: `agentStopFrom` already maps `max_tokens`/`content_filter` to a distinct `AgentStopReason` (never disguised as `end_turn`), and tool-argument truncation already returns an error `tool_result` via `TRUNCATED_TOOL_HINT` — both with passing tests (`stops with max_tokens when the model truncates a text-only turn`, `returns an error tool_result and continues when truncation hits mid tool args`). So truncation is **not** silently treated as complete — it already surfaces as a distinct, user-visible stop reason (`STOP_NOTICES` in the web UI). The one still-open piece: pure-text truncation stops the run rather than bounded auto-continuation (the doc's suggested remedy #2, hermes-agent-style). Left as an optional small enhancement, not urgent — see `docs/runtime-learnings.md` §2. |
| 3 | No general mid-turn recovery for context-length-exceeded → **RESOLVED, stale doc claim** | **E** Context Engineering | A, B | Was High, now closed | Done | **Re-verified against code**: `loop.ts` already implements exactly the suggested remedy — a `ProviderError('context_length')` triggers at most one mid-turn compaction-and-resend salvage per turn when `onCompact` is configured, falling through to the normal error path otherwise. No residual issue found. See `docs/runtime-learnings.md` §3. |
| 4 | Unrepaired dangling tool_use without tool_result on `--resume` → **RESOLVED, stale doc claim** | **I** Operational Hardening | B | Was High-if-confirmed, now closed | Done | **Re-verified against code** (the original doc explicitly called this "inferred, not reproduced" — now checked directly): `packages/core/src/agent/session.ts`'s `loadSession` always runs `normalizeHistory`, which backfills a synthetic `{content: 'aborted', isError: true}` tool_result for any orphaned `tool_use`, with dedicated unit tests (`normalizeHistory` suite) and an integration test (`fills aborted tool_results when resume history has tool_use without results`). No residual issue found. See `docs/runtime-learnings.md` §4. |
| 5 | No native Anthropic provider (Claude only reachable via OpenRouter/proxy) | **A** Model/Provider Layer | G (blocks benchmarking hc against/with Claude) | High strategic / Low immediate-reliability | M | Add a native Anthropic Messages API adapter in the provider layer, parallel to the OpenAI-compatible layer, reusing existing tool-calling translation logic. **Deferred — not a current priority** (see §3). |
| 6 | Scratch-file sprawl | **H** Agentic Behavior Quality | C (a structural scratch-dir convention is a tool-system lever) | Medium — hygiene/workflow, not correctness | S–M | (a) system-prompt instruction change; (b) structural — give the harness a designated scratch directory so cleanup is a convention it enforces rather than one the model must remember. |
| 7 | Late commitment to the real deliverable | **H** Agentic Behavior Quality | G (needs a measurable proxy) | Medium | M | Add a telemetry-observable proxy metric (time/turns-to-first-touch of the actual deliverable file), then iterate prompt/nudge wording against that metric rather than vibes. |
| 8 | Over-engineering / no simplicity bias | **H** Agentic Behavior Quality | G (needs an eval signal) | Medium | M | Add an explicit "prefer the smallest correct change" instruction, plus an eval-harness check (diff size / new-file count vs. task-declared scope) surfaced in `baseline.json` runs. |
| 9 | Fussing over trivial details near the turn-budget wall | **H** Agentic Behavior Quality | E (the nudge mechanism itself) | Medium | S–M | Tune the existing 80%-of-budget nudge copy to explicitly say "stop polishing, ship current state"; consider a distinct "hard wrap-up mode" past 90%. |
| 10 | Turn-budget nudge has a measured net regression on optimization-style tasks | **E** Context Engineering | H (net effect on task success is a behavior-quality question) | Medium — currently net positive (+2/-1) but not clean | M | Make the nudge conditional on task-shape signals (e.g. repeated-iteration patterns in todo-list state) so optimization/iterative tasks get a softened or suppressed nudge. Needs the ablation runner (#13) to measure properly. |
| 11 | Markdown raw-display bug (unspecified) | **F** Protocol & State Sync (web rendering) | — | Low–Medium — cosmetic, in an actively-refactored area | S | `Markdown.tsx`/`MarkdownBody.tsx` suggest a rendering split mid-flight. Pin an exact repro against current uncommitted state, then check for a raw-text fallback path not routed through the sanitized/highlighted renderer. |
| 12 | Edit-preview docs/code discrepancy | **G** Observability (doc hygiene) | F (the actual UI code lives here) | Low — **verified already fixed in code since commit `f570301`**; pending refactor was a half-finished regression, now fixed — **DONE 2026-09-12** | S (turned out to include one real M test-fix, still small) | Done: corrected the stale TODO line in `docs/web-frontend.md`; found the pending diff/markdown lazy-loading refactor (`registry.tsx`, `diffPanels.tsx`, `Markdown.tsx`, `MarkdownBody.tsx`) was breaking 4/8 tests in the already-committed `render.test.tsx` (assertions ran before the `Suspense` boundary resolved); fixed the test file to `await` lazy resolution and committed the whole batch together, now green (63/63 in `packages/web`). Note: `Transcript.test.tsx` (gap #11's concern) and `packages/server/src/registry.test.ts` (unrelated server-side batch) were left untouched — out of scope for this gap. |
| 13 | No committed runner for sub-agent / native-vs-prompt tool-calling ablations | **G** Observability & Eval | H (instrument needed to trust H conclusions) | Medium — blocks measuring two architecturally significant knobs | M | Wire the existing harness flags into a runner script under `evals/` that sweeps both dimensions against the cassette suite, and periodically a small Harbor subset, writing results alongside `baseline.json`. |
| 14 | Full 89-task Harbor benchmark incomplete (18/89 run) | **G** Observability & Eval | — | Medium — capability numbers are provisional, risk of overclaiming | L (budget/time, not engineering) | Schedule/fund the remaining 71 tasks; until then, label all capability claims "18/89 provisional" everywhere cited. |
| 15 | `.gitignore` parser doesn't handle negation (`!`) or character classes | **C** Tool System & Execution | I (same risk class as the 639%-blowup incident) | Low–Medium — negation patterns are common enough to silently re-admit a blowup — **DONE 2026-09-12** | S–M | Done: replaced the hand-rolled glob-conversion parser in `packages/core/src/tools/grep.ts` with the `ignore` npm package (proper gitignore semantics, incl. negation), filtering the already-listed file set instead of pre-translating patterns into fast-glob ignore-globs. New regression test: `honours a .gitignore negation, re-admitting a file its own broader pattern excluded` (`grep.test.ts`). |
| 16 | Errors before an output sink exists exit via plain text, not structured JSON | **I** Operational Hardening | G (breaks headless/automation progress-JSON consumers for this error class) | Low–Medium — narrow but real: `--model` typos / missing config are exactly what automation hits first — **PARTIALLY DONE 2026-09-12** | S | Done for the specific case verified: `NoModelConfiguredError` (no `--model` and no default configured) now routes through a new `failWithFormat` helper in `packages/cli/src/index.ts`, which emits the same structured `{type: "result", is_error: true}`/`{type: "error"}` shape a mid-run failure would for `--output-format json`/`stream-json`, instead of always falling back to the plain-text `fail()`. **Not yet covered**: other pre-config errors (e.g. an unknown provider name, which throws a plain `Error` from deeper in `buildSessionConfig`/`ProviderRegistry` and is still only caught by the generic `unhandledRejection` handler as plain text) — confirmed still plain-text via manual test. Broadening this to all pre-sink error paths would need touching the top-level `main()`/`unhandledRejection` handler too; left as a follow-up given the narrower, explicitly-named case is what's fixed here. |

---

## 3. Prioritized Roadmap

**Guiding principle:** fixes that *corrupt or bias measurement* (loop correctness bugs, eval infra) must land before behavior-quality tuning (H) or large benchmark spend (G) — otherwise a real regression can't be told apart from an artifact of a known bug.

> **Dependency call-out:** #1 (tool-call reordering) and #2 (truncated-output-as-complete) must be fixed before nudge/behavior-ceiling work (#9, #10) is trusted. Both bugs can produce spurious task failures/successes that have nothing to do with the nudge wording or simplicity bias being tuned — tuning H against an A/B-corrupted signal risks optimizing against noise.

This ordering also reflects the user's stated priorities: **(1) Correctness/Reliability P0 → (2) Agentic Behavior Quality → (3) Web UI TODOs + Eval completeness**, with the native Anthropic provider (not selected) pushed to deferred status.

> **2026-09-12 update — Phase 0 and Phase 2 are done.** Re-verifying #1–#4 against the actual code (not just the docs that named them) found that #2's critical part, #3, and #4 were *already fixed and tested* before this session started — the source doc (`docs/runtime-learnings.md`) was simply never updated. #1 had a genuinely real, previously-untested residual bug (concurrent-batch `tool_call_end`/recorder/trace ordering), which was found and fixed in this session with a new regression test. The only correctness item left open at all is a small, non-urgent enhancement (#2's bounded text-truncation continuation). Practical effect: **the dependency gate for Phase 4 (agentic behavior tuning) is now satisfied** — the loop-correctness noise that would have confounded nudge/behavior-quality measurement is gone.

### Phase 0 — Correctness foundation (user priority #1) — ✅ DONE (2026-09-12)
1. ~~**#2** Truncated-output detection~~ — already implemented pre-session; verified with existing tests. Residual: bounded text-continuation enhancement, optional, not urgent (see gap table).
2. ~~**#1** Tool-call reordering fix~~ — execution order was already fixed pre-session; this session found and fixed the real residual (event/log ordering within a concurrent batch) and added a regression test.

### Phase 1 — Cheap hygiene, parallelizable with Phase 0 — ✅ DONE (2026-09-12)
3. ~~**#12** Doc/commit cleanup for edit-preview~~ — done; turned up and fixed a half-finished lazy-loading refactor along the way (see §2, gap #12).
4. ~~**#16** Structured error sink for pre-sink failures~~ — done for the `NoModelConfiguredError` case; other pre-config error paths (e.g. unknown provider name) still exit as plain text, left as a follow-up (see §2).
5. ~~**#15** Swap grep's ignore parser for a library~~ — done; `ignore` npm package now backs `.gitignore` handling in the grep tool, with a negation regression test.

### Phase 2 — Robustness completion (still user priority #1) — ✅ DONE (2026-09-12)
6. ~~**#3** Generalize context-exceeded mid-turn recovery~~ — already implemented pre-session; verified against code, no residual issue.
7. ~~**#4** Dangling tool-call repair~~ — already implemented pre-session (`normalizeHistory`); verified against code and its test suite, no residual issue.

### Phase 3 — Trustworthy measurement infra (serves user priority #3, prerequisite for #2)
8. **#13** Ablation runners for sub-agent and native-vs-prompt tool-calling (M) — build before spending further effort tuning nudges (#10), since #10's remedy explicitly depends on it.
9. **#14** Continue the 89-task Harbor benchmark (L, budget-gated) — resume once Phase 0 lands; until then keep "18/89 provisional" labeling.

### Phase 4 — Agentic behavior ceiling (user priority #2, now measurable via Phase 3)
10. **#9** Nudge copy tuning near the budget wall (S–M)
11. **#10** Nudge regression on optimization tasks (M) — use #13's runner to measure before/after, not vibes.
12. **#7** Late-commitment-to-deliverable metric + prompt iteration (M)
13. **#8** Simplicity-bias instruction + eval check (M)
14. **#6** Scratch-file sprawl convention (S–M)

### Phase 5 — Remaining Web UI item
15. **#11** Markdown raw-display bug (S) — standalone, low-risk, slot in whenever convenient.

### Deferred / out of current scope
16. **#5** Native Anthropic provider (M) — high strategic value, but not one of the three categories chosen to prioritize right now. Retained here so it isn't lost; additive/non-confounding work that can proceed independently whenever picked back up, but shouldn't be used for comparative benchmarking until Phase 0's loop fixes are in (or Claude-vs-other-model comparisons inherit the same ordering/truncation noise).

---

## 4. Quick-scan severity × effort grid

**As of 2026-09-12** (post-verification and Phase 0–2 work; #1–#4, #12, #15 closed, #16 partially closed — see §2/§3):

| Severity | S effort | M effort | L effort |
|---|---|---|---|
| Critical | — | — | — |
| High | — | #5 | — |
| Medium | #2 (residual) | #6, #7, #8, #9, #10, #13 | #14 |
| Low | #11 | — | — |
| Closed | #1, #3, #4, #12, #15, #16-partial (done) | #2's critical part (done) | — |

(Treat this grid as a quick-scan aid — the per-gap table in §2 is authoritative.)
