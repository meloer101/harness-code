# `hc` on Harbor / Terminal-Bench 2.0

This directory wires `hc` (this repo's harness) into
[Harbor](https://www.harborframework.com/) so it can be scored on
**Terminal-Bench 2.0** — ~89 real containerised terminal tasks, graded by each
task's own `tests/test.sh`.

It is complementary to `pnpm eval` (repo root): that suite is a deterministic
cassette-replay regression gate on 5 fixtures; this one is real-model,
container-isolated capability measurement on a public benchmark.

## Files

| file | what |
|---|---|
| `hc_agent.py` | Harbor **installed-agent adapter** — `HcAgent(BaseInstalledAgent)`. Ships the `hc` bundle into each task container and runs it headless. |
| `subset.txt` | The task ids for the baseline run (tune freely). |
| `run-subset.sh` | Convenience wrapper around `harbor run` for the subset. |

Nothing here is imported by `packages/*`; `hc` itself is untouched.

## One-time setup

```bash
uv tool install harbor          # the harness runner
# Docker must be running (local sandbox)
```

## Every run

```bash
pnpm bundle                     # -> dist-bundle/hc.mjs  (single-file hc)
export DEEPSEEK_API_KEY=...      # key for the model you benchmark
```

`hc` is a pnpm-workspace app that is never published, so the adapter cannot
`npm i` it — `pnpm bundle` produces one self-contained `dist-bundle/hc.mjs`
that the adapter uploads into the container and runs under a bare `node`
(installing Node 22 via nvm/apk if the task image lacks it).

## Run the subset

```bash
evals/harbor/run-subset.sh
```

Env knobs: `HC_BENCH_MODEL` (default `deepseek/deepseek-v4-pro`),
`HC_BENCH_KEY_ENV` (default `DEEPSEEK_API_KEY`), `HC_BENCH_CONCURRENCY`
(default 4), `HC_BENCH_JOBS_DIR` (default `evals/harbor/.jobs`).

### Single task (debugging the adapter)

```bash
PYTHONPATH=evals/harbor harbor run \
  -d terminal-bench/terminal-bench-2 -a hc_agent:HcAgent \
  -m deepseek/deepseek-v4-pro -t fix-code-vulnerability -n 1 -y \
  --ae DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY

# just the install step (fast image-compat check, no model spend):
PYTHONPATH=evals/harbor harbor run ... --install-only
```

### Oracle sanity (no `hc`, no model — checks Harbor + Docker + dataset)

```bash
harbor run -d terminal-bench/terminal-bench-2 -a oracle -l 1 -n 1 -y
```

## Agent kwargs (`--ak key=value`)

| kwarg | default | meaning |
|---|---|---|
| `hc_mode` | `yolo` | hc permission mode. `yolo` = full auto; anything stricter will make hc refuse writes/bash unattended. |
| `max_turns` | `40` | hc `--max-turns`. |

## Reading results

Each trial dir (`<jobs>/<timestamp>/<task>__<id>/`) has:

- `verifier/` — Harbor's grading; `reward.json` / `reward.txt` is the score.
- `agent/hc-result.json` — hc's own one-shot JSON: `stop_reason`, `turns`,
  `usage.{input_tokens,output_tokens,cached_input_tokens,cost_usd}`. Written
  even when the run crashes: then `stop_reason` is `"error"`, `is_error` is
  true, and `error.{message,kind}` says why.
- `agent/hc.log` — hc's stderr. With `--output-format json` this is a JSONL
  progress stream written *during* the run — one object per line with `type`
  `notice` / `tool_start` / `tool_end` / `turn_end` / `turn_retry` /
  `compaction` / `stop` and a `ts` (epoch ms), e.g.
  `jq -c 'select(.type=="tool_end" and .is_error)' hc.log`. Pass
  `--no-progress` to turn it off.
- `agent/hc-traces/` — hc's `.agent/traces/*.jsonl`, inspectable with
  `hc trace <id> --cwd <that dir's parent>`.

`result.json` at the job root has the pass rate + token/cost rollup (token/cost
come from the adapter's `populate_context_post_run`).

## How it works

`hc_agent.py`:

1. `install()` — ensure Node ≥ 20 (nvm 22 on glibc, `apk add nodejs` on musl),
   upload `dist-bundle/hc.mjs` to `/opt/hc/hc.mjs`, drop a
   `/usr/local/bin/hc` wrapper.
2. `run()` — `hc agent "<instruction>" --model <m> --mode yolo
   --output-format json --no-mcp --no-skills --no-subagents --max-turns N`,
   with the provider API key passed through the env. Grading is left entirely
   to Harbor's verifier; `hc` exits 0 regardless of task success.
3. `populate_context_post_run()` — parse `hc-result.json` → token/cost back
   to Harbor.

`hc` and Harbor share the `provider/model` naming convention, so the model
name passes straight through. `hc` speaks OpenAI-compatible Chat Completions
only (no native Anthropic) — see `packages/core/src/provider/router.ts` for
the built-in provider list.
