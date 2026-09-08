# Eval

`pnpm eval` runs the whole agent loop — real `builtinTools`, real permission
engine, real compaction — against a set of fixture tasks and reports whether the
agent solved them, how many turns it took, and what it cost. The model is served
from a **committed cassette** (`RecordingProvider` / `ReplayProvider` in
`packages/core/src/provider/mock.ts`), so CI reruns it identically with no network
and no credentials. A regression — a task that stops passing, or a >15% rise in
tokens or cost — fails the command.

```
pnpm eval                       # replay every task, assert, gate on baseline.json
pnpm eval --task fix-null-deref  # one task (repeatable)
pnpm eval --runs 5              # override each task's run count
pnpm eval --update-baseline     # write the current numbers to baseline.json
pnpm eval --no-gate             # report regressions but exit 0
pnpm eval --keep                # leave the fixture workspaces on disk
```

Maintainer-only (hits the real endpoint, needs a key in `.env`):

```
pnpm eval --record --model deepseek/deepseek-v4-flash   # re-record cassettes + baseline
pnpm eval --ablation compaction                          # compaction on/off comparison
```

## A task

```
evals/tasks/<id>/
  task.json        { id, prompt, model, mode, tags, runs, expectRefusal?, allow?, deny?, maxTurns? }
  fixture/         copied verbatim into a fresh realpath'd temp workspace per run
  assert.mjs       run with cwd = the post-run workspace; exit 0 = pass
  cassette.jsonl   the recorded model exchanges (committed)
```

`assert.mjs` is a plain Node script with no dependencies — it runs the fixture's
own `node --test` suite, greps the diff, checks a file is untouched, whatever the
task needs. A **refusal** task (`expectRefusal: true`) asserts that the forbidden
outcome never landed; whether the agent declined in conversation or the
permission engine blocked its attempt (`deniedToolCalls`, reported alongside)
both satisfy it.

## Adding a task

1. `mkdir evals/tasks/<id>` with `task.json`, `fixture/`, and `assert.mjs`.
2. `pnpm eval --record --task <id>` — records `cassette.jsonl` against the real
   model and folds the result into `baseline.json`.
3. `pnpm eval --task <id>` — confirm it replays and the assertion still passes.
4. Commit the cassette and the baseline.

## Cassette portability

The request fingerprint (`requestKey`) hashes the system prompt and the full
message history, both of which embed the absolute workspace path (the
`environment` segment, `grep` output, and paths the model writes in tool calls).
The harness hands the recorder/replayer `redactPaths: [workDir]`: on record every
occurrence of that path is rewritten to `$HC_WORKSPACE` throughout the cassette;
on replay the sentinel is expanded back to *this* run's temp dir before events
are handed to the loop, and scrubbed back out before the key is computed. A
`keyScrub` also normalizes `node --test`'s per-run `duration_ms:` timings. The
net effect: a cassette recorded on one machine, in one random temp dir, replays
byte-identically anywhere.

## Ablations

`--ablation compaction` runs the suite twice under a deliberately tight context
window (so small tasks still brush the ceiling) — once with compaction on, once
off — and prints a side-by-side table. It always hits the real model; the numbers
go in the README, not the regression gate. Sub-agent and native-vs-prompt-tools
ablations have harness support (`subagents`, `promptTools` on `HarnessOptions`)
but no committed runner path yet.

## Traces

Every run writes a telemetry trace to
`evals/.results/<run>/​.agent/traces/<task>-<n>.jsonl`. Inspect one with
`hc trace <task>-<n> --cwd evals/.results/<run>`.
