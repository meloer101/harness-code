# Harbor / Terminal-Bench 2.0

`pnpm eval` (see [eval.md](eval.md)) is the deterministic, offline regression
gate — 5 fixtures, cassette replay, no network, gated on `baseline.json`.

**Harbor** is the other half: real-model, container-isolated capability
measurement on a public benchmark. It runs `hc` unmodified inside
[Terminal-Bench 2.0](https://www.harborframework.com/)'s ~89 task containers
and scores it with each task's own `tests/test.sh`.

| | `pnpm eval` | Harbor |
|---|---|---|
| model | committed cassette | real API call |
| isolation | temp dir on host | Docker container per task |
| tasks | 5 repo fixtures | 89 public TB2 tasks (run a subset) |
| grades | `assert.mjs` (host node) | task's `test.sh` → `reward.json` |
| use | CI gate, every PR | periodic baseline, capability tracking, cross-harness comparison |

Everything lives in [`evals/harbor/`](../evals/harbor/README.md) — a Harbor
installed-agent adapter (`hc_agent.py`), the task subset, and a run script.
`hc` itself and the existing `evals/` suite are untouched.

## Quick start

```bash
uv tool install harbor          # once; Docker must be running
pnpm bundle                     # -> dist-bundle/hc.mjs (single-file hc)
export DEEPSEEK_API_KEY=...
evals/harbor/run-subset.sh
```

See [`evals/harbor/README.md`](../evals/harbor/README.md) for single-task
debugging, agent kwargs, and how to read the trial output.

## Baseline

**hc @ terminal-bench-2, 18-task subset** — `deepseek/deepseek-v4-pro`, local Docker
(amd64 under Rosetta), `-n 3`, 2026-09-08. **11/18 = 61.1%** (Harbor counts the 2
exceptions as 0; excluding them, 11/16 = 68.8%). Total: 8.8M in / 228K out tok, **$4.07**, 56 min.

| task | reward | hc turns | stop | cost $ |
|------|:---:|:---:|------|---:|
| fix-git | ✅ 1 | 9 | end_turn | 0.032 |
| git-leak-recovery | ✅ 1 | 10 | end_turn | 0.037 |
| log-summary-date-ranges | ✅ 1 | 7 | end_turn | 0.040 |
| kv-store-grpc | ✅ 1 | 14 | end_turn | 0.047 |
| fix-code-vulnerability | ✅ 1 | 13 | end_turn | 0.092 |
| distribution-search | ✅ 1 | 23 | end_turn | 0.158 |
| git-multibranch | ✅ 1 | 28 | end_turn | 0.275 |
| count-dataset-tokens | ✅ 1 | 40 | max_turns | 0.260 |
| large-scale-text-editing | ✅ 1 | 40 | max_turns | 0.268 |
| largest-eigenval | ✅ 1 | 40 | max_turns | 0.273 |
| cancel-async-tasks | ✅ 1 | 40 | max_turns | 0.358 |
| break-filter-js-from-html | ❌ 0 | 40 | max_turns | 0.242 |
| chess-best-move | ❌ 0 | 40 | max_turns | 0.245 |
| cobol-modernization | ❌ 0 | 40 | max_turns | 0.323 |
| db-wal-recovery | ❌ 0 | 40 | max_turns | 0.559 |
| gcode-to-text | ❌ 0 | 40 | max_turns | 0.863 |
| adaptive-rejection-sampler | ❌ 0 | — | Harbor agent timeout (Rosetta) | — |
| filter-js-from-html | ❌ 0 | — | (was: hc crash — [fixed](#the-filter-js-from-html-crash)) | — |

Observations:
- 5 of 7 real failures hit `max_turns` (40); 4 *passes* also ran to 40 without
  stopping — hc tends to keep polishing after it's effectively done.
- `max_turns` runs still cost $0.24–0.86 each (gcode-to-text: 2.1M input tokens).

### Turn-budget nudge (2026-09-09)

That "runs to the wall" pattern drove the turn-budget nudge in
`packages/core/src/agent/loop.ts` (`turnBudgetNote`). Re-running the 9 tasks
that hit `max_turns`, nudge on vs off (`deepseek/deepseek-v4-pro`,
`--agent-timeout-multiplier 2.5` for the slow three):

| task | baseline | nudge | note |
|------|:---:|:---:|------|
| break-filter-js-from-html | ❌ | ✅ | stopped the XSS-variant whack-a-mole, wrote a principled filter |
| cobol-modernization | ❌ | ✅ | |
| db-wal-recovery | ❌ | ✅ | was $0.56 spelunking `/proc` + caps; converged at turn 21, $0.10 |
| cancel-async-tasks | ✅ 40t | ✅ 9t | |
| large-scale-text-editing | ✅ 40t | ✅ 18t | |
| count-dataset-tokens | ✅ 40t | ✅ 30t | |
| largest-eigenval | ✅ | ❌ | **known regression.** A perf-optimisation task: the nudge makes it commit to chasing the fastest approach (C extension, ctypes→LAPACK) and it never falls back to writing a plain `eigen.py`. Adding a "fall back to the simplest implementation" clause to the ≥80% tier did **not** recover it on a re-run — the pull of the optimisation goal wins. |
| chess-best-move | ❌ | ❌ | genuinely hard (board-from-image, network-blocked) |
| gcode-to-text | ❌ | ❌ | genuinely hard |

**4/9 → 6/9** on this slice (net +2: break-filter / cobol / db-wal flip to
pass, largest-eigenval flips to fail); the three already-passing tasks shed
~50 turns and ~$0.65 combined. Projected onto the full subset: ~61% → ~72%.

Run-to-run noise is significant under Rosetta on a loaded machine — db-wal-recovery
passed at turn 21 on one nudge run and hit Harbor's wall-clock agent timeout on
another. Treat single-task flips as directional, not exact.

### The `filter-js-from-html` crash

That run surfaced a real hc bug: a model call whose streaming response ran past
the 10-min provider timeout threw an **uncaught `DOMException [TimeoutError]`**
(`AbortSignal.timeout` timer leaked past the request, fired on a signal with no
listener) → unhandled rejection → process exit → Harbor `NonZeroAgentExitCodeError`.

Fixed in `packages/core/src/provider/openai-compat.ts`: the per-request deadline
is now a controlled `AbortController`/`setTimeout` cleared when the response is
consumed; a timeout mid-stream is normalised to a **retryable `ProviderError`**;
`packages/core/src/agent/loop.ts` ends the run at `stopReason:'error'` for any
other error escaping the provider; `packages/cli/src/index.ts` has an
`unhandledRejection` guard so a stray late timer is one line + exit 1, never a
stack dump. Regression tests in `openai-compat.test.ts`.

## Notes / limits

- `hc` speaks OpenAI-compatible Chat Completions only (no native Anthropic);
  `provider/model` names pass straight through to `hc --model`.
- `hc` runs with `--mode yolo` (full auto) — required for an unattended run.
- `hc` exits 0 regardless of task success; Harbor's verifier is the sole grader.
- Hard-denied even under `yolo` (`packages/core/src/permissions/bash-ast.ts`):
  `$(...)`, `node -e`/`python -c`, `cmd | sh`. A task the agent can only solve
  that way will score 0.
- Cross-harness comparison (`-a claude-code`, `-a codex`) is a later step —
  same command, different `-a`.
