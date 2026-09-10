# Telemetry

Every `hc agent` run writes a structured trace to `.agent/traces/<session-id>.jsonl`
— one JSON object per line, appended as each event happens (a crash loses at most
the in-flight turn). The id is the same one `--resume` uses, so a session's
messages (`.agent/sessions/<id>.jsonl`) and its trace line up.

It is a **separate file** from the session log on purpose. The session log is the
resume-critical path — messages only. The trace carries the volatile, lossy
numbers (token counts, cache hits, latency, tool durations, input summaries, byte
counts) that `hc trace` and `hc stats` read without ever touching `loadSession`.

Tracing is on by default. Turn it off per run with `--no-trace`, or persistently
with `"telemetry": { "enabled": false }` in `.agent/settings.json`.

## Commands

```
hc trace [id]            # replay one session as a timeline (newest if id omitted)
hc trace <id> --json     # the raw event array
hc stats                 # totals across every trace: tokens, cost, turns, cache %, by model
hc stats --since 2026-09-01
hc stats --json
```

`hc trace` groups events by run (`run_start` … `run_end`; the REPL writes one pair
per user message), indents tool and sub-agent events under their turn, and shows
each event's offset from the start of the trace.

## Event schema

`packages/core/src/telemetry/trace.ts` — `TraceEvent` is a discriminated union on
`type`, every variant carries `ts` (epoch ms):

| `type` | key fields |
| --- | --- |
| `run_start` | `sessionId`, `model` (the `provider/model` ref), `cwd`, `mode`, `resumed` |
| `model_call` | `turn`, `model`, `inputTokens` / `outputTokens` / `cachedInputTokens`, `reasoningTokens?`, `costUSD?`, `latencyMs?`, `ttftMs?`, `stopReason`, `estimated?` |
| `tool_call` | `turn`, `id`, `name`, `inputSummary` (stringified input, capped at 200 chars), `durationMs`, `isError`, `denied?` (the permission engine refused it — never ran), `outputBytes`, `endsRun?` |
| `compaction` | `turn`, `tokensBefore`, `tokensAfter`, `keptTurns`, `costUSD?` |
| `context` | `turn`, `usedTokens`, `windowTokens`, `ratio`, `breakdown` (`sys` / `skills` / `projectMemory` / `toolSchemas` / `history`) — one per turn |
| `subagent` | `name`, `turns`, token fields, `costUSD?`, `stopReason` — a rollup of one dispatched sub-agent |
| `error` | `turn`, `scope` (`provider`), `message`, `willRetry?` — a provider error; `willRetry: true` means it was retryable and the loop re-sent the turn (see `maxTurnRetries`), otherwise it escaped the loop |
| `run_end` | `stopReason`, `turns`, token fields, `costUSD?`, `wallMs` |

### What is not recorded

- **Tool output.** Only `outputBytes` and `isError`. The full text is already in
  the session log; duplicating multi-megabyte grep dumps here is the hazard
  [grep-output-blowup.md](./grep-output-blowup.md) describes.
- **Prompts / message content.** The trace is about cost and shape, not content.
- **Cost for unpriced models.** `costUSD` is present only when the model has a
  pricing rule (`provider/capabilities.ts`). `hc stats` reports how many sessions
  had unpriced calls so the total is never silently understated.

A `tool_call` with `denied: true` is what the eval suite's refusal-correctness
metric counts (`summarizeTrace` surfaces it as `deniedToolCalls`); `hc trace`
renders it as `denied` rather than `error`.

## Sub-agents

A dispatched sub-agent (`task` tool) runs its own `AgentLoop` with no recorder of
its own. The parent writes a single `subagent` rollup event — name, turn count,
summed tokens, cost, stop reason — from the data in `SubagentResult`. So
`hc stats` token and cost totals include sub-agent work, but there is no
per-sub-agent timeline. (Consistent with Phase 7 keeping sub-agents lightweight;
a full child trace file is a possible later extension.)

## How the loop feeds it

`AgentLoop` takes an optional `trace?: TraceSink` — a narrow interface the loop
declares (`modelCall` / `toolCall` / `compaction` / `context` / `error`), which
`TraceRecorder` satisfies structurally. The loop `await`s it at the same points it
feeds `SessionRecorder`. `run_start` / `run_end` / `subagent` are written by the
CLI, which owns the recorder and the sub-agent dispatch closure. `AgentEvent` (the
live `onEvent` stream) is unchanged.
