# harness-code

A coding agent built from scratch — MCP client and server, skills, plan mode,
and the harness engineering underneath: context management, a permission
sandbox, sub-agents, and an eval suite that measures whether any of it works.

> Status: **Phase 3 of 10**. The provider compatibility layer, agent loop,
> tool set, and permission sandbox are complete and tested. Context
> engineering, MCP, skills, plan mode, sub-agents, telemetry and the TUI are
> still ahead — see [the plan](#roadmap).

## Why this exists

Wrapping an LLM in a `while` loop takes an afternoon. Making that loop useful on
a real codebase is the actual work, and almost all of it lives in the harness:
deciding what goes into the context window and what gets summarized away,
refusing the tool call that would delete something, isolating a noisy search
into a sub-agent, and being able to prove — with numbers — that a change to any
of those made the agent better rather than merely different.

This repository is that harness, written to be read.

## What works today

```bash
pnpm install && pnpm build

node packages/cli/dist/index.js models          # what's configured, what has keys
node packages/cli/dist/index.js raw "explain async generators" -m deepseek/deepseek-v4-flash
node packages/cli/dist/index.js doctor          # resolved settings and their sources

# the full agent loop: read/write/edit/glob/grep/bash/todo, gated by the
# permission engine, streamed to the terminal, recorded to a resumable session
node packages/cli/dist/index.js agent "add input validation to parseConfig" \
  -m deepseek/deepseek-v4-pro --mode ask

# same loop, interactive: omit the prompt to get a plain-text back-and-forth
# session instead of a one-shot run — bare `hc` (no subcommand) does the same
node packages/cli/dist/index.js agent --cwd . -m deepseek/deepseek-v4-pro --mode acceptEdits
```

`agent` runs the ReAct-shaped loop end to end: it streams the model's
reasoning, executes any tool calls the permission engine allows (read-only
tools in parallel, writes serialized), feeds the results back, and repeats
until the model stops asking for tools or a turn/cost budget is hit. Every
message and tool call is appended to `.agent/sessions/<id>.jsonl` as it
happens, so `--resume <id>` picks the conversation back up.

Passing `<prompt>` runs one turn and exits — the scriptable form. Omitting
it drops into a `readline` REPL: the same loop and the same `SessionState`
(so the read-before-edit ledger persists across messages, not just within
one) carry over turn to turn, Ctrl+C aborts an in-flight turn without
killing the session, and a second Ctrl+C at an idle prompt (or `exit`/
Ctrl+D) ends it cleanly. This isn't the Ink TUI from the roadmap below —
no panels, no slash commands — just plain text in, streamed text out,
which is what actually makes it usable to talk to instead of re-typing a
whole command line per message.

## The compatibility layer

One adapter speaks OpenAI Chat Completions, and everything routes through it:
DeepSeek, Moonshot/Kimi, Qwen via DashScope, Zhipu, SiliconFlow, OpenRouter,
Groq, Together, Mistral, xAI, a LiteLLM proxy, Ollama, vLLM and llama.cpp.
Models are named LiteLLM-style — `provider/model`, split on the first slash so
`openrouter/anthropic/claude-sonnet-4` survives intact.

"OpenAI-compatible" is a spectrum rather than a contract, so the adapter is
mostly a catalogue of the ways endpoints differ:

| Divergence | How it is handled |
| --- | --- |
| Streamed `tool_calls` deltas arrive with a stable `index`, no `index` at all, or the whole call in one chunk | [`ToolCallAccumulator`](packages/core/src/provider/openai-compat.ts) reassembles all three, plus split and repeated `function.name` |
| `finish_reason` says `stop` while tool calls are in the payload | The payload wins — believing the field would strand the loop with the tool never run |
| Reasoning arrives as `reasoning_content` (DeepSeek) or `reasoning` (OpenRouter) | Both map to a `thinking` block, and are dropped on the way back out because endpoints reject replayed reasoning |
| Cached-prompt tokens are reported under three different field names | All three normalized into `usage.cachedInputTokens` |
| No usage reported at all (Ollama, most llama.cpp builds) | Estimated and flagged `estimated: true`, with CJK weighted separately from ASCII |
| No `tools` parameter at all | [Prompt-encoded tool calling](packages/core/src/provider/prompt-tools.ts) — schemas go into the system prompt and calls are parsed back out of the token stream, without leaking tag markup to the terminal |
| Arguments truncated by `max_tokens`, wrapped in code fences, or written with Python literals | [Tolerant parsing](packages/core/src/util/json.ts) with each repair recorded, so a salvaged parse is distinguishable from a clean one |

Adding an endpoint is normally a data change in
[`router.ts`](packages/core/src/provider/router.ts), plus a capability row if it
is unusual.

## The agent loop

[`agent/loop.ts`](packages/core/src/agent/loop.ts) is a ReAct-shaped state
machine — assemble the request, stream the model's reasoning, collect any
tool calls, run them, feed the results back, repeat — with policy kept out
of the loop entirely and injected through `AgentHooks`
(`onBeforeTurn` / `onBeforeToolCall` / `onAfterToolCall`) instead of `if`
branches. Read-only, concurrency-safe tool calls run in parallel; writes run
serially; a denied call never executes. The loop stops on `end_turn`,
`max_turns`, `max_cost`, or an aborted signal — `Ctrl+C` propagates through
an `AbortSignal` all the way down to a running `bash` child process.

[`tools/`](packages/core/src/tools) ships `read`, `write`, `edit`, `glob`,
`grep`, `bash`, and `todo`, each declaring `readOnly` / `concurrencySafe`
metadata that the loop's scheduler and the permission engine both consume.
`edit` and `write` enforce a read-before-write invariant: a file has to have
been read in this session before it can be edited, using the same
`SessionState` that will grow into Phase 4's full read ledger.

[`permissions/`](packages/core/src/permissions) is a rule engine over
`Tool(specifier)` patterns — `Bash(git status:*)`, `Read(./src/**)` — with
`allow` / `ask` / `deny` lists (deny always wins) across five modes (`ask`,
`plan`, `acceptEdits`, `readOnly`, `yolo`). Bash commands are parsed with
`shell-quote` into an AST rather than matched by regex, so compound commands
(`&&`, `|`, `;`, subshells) are judged segment by segment; a path cage
resolves symlinks and blocks traversal outside the workspace; a built-in
denylist blocks `.env*`, `.git/config`, private keys, and similar. In a
non-interactive run, an `ask` verdict has no one to ask, so it deterministically
denies rather than hanging.

## Testing

172 tests, no network, no credentials, no API spend:

```bash
pnpm test
```

Provider behaviour is tested through injected transports — synthesized SSE
frames for stream assembly, and a record/replay cassette for anything that once
came from a real endpoint. Determinism here is a prerequisite for the eval
suite in Phase 8: a benchmark you cannot re-run identically cannot tell you
whether last week's change helped.

The agent loop, tools, and permission engine are covered the same way: a
scripted provider stands in for the model (queue up tool calls and text
turns, assert on what the loop does with them), so concurrency behaviour,
budget cutoffs, and permission denials are all deterministic without a real
endpoint.

## Layout

```
packages/core     provider layer · agent loop · tools · context · permissions · mcp · skills · telemetry
packages/cli      one-shot, scriptable entry point
packages/tui      interactive terminal UI (Ink)
evals             benchmark tasks and fixtures
```

## Roadmap

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Workspace, build, CI | done |
| 1 | Provider compatibility layer | done |
| 2 | Agent loop and tools | done |
| 3 | Permissions and sandbox | done |
| 4 | Context engineering — compaction, project memory, cache stability | compaction + project memory + edit-staleness done; output truncation + cache telemetry next |
| 5 | MCP client and server | |
| 6 | Skills and plan mode | |
| 7 | Sub-agents and parallelism | |
| 8 | Telemetry and eval suite | |
| 9 | CLI and TUI | |
| 10 | Documentation | |

Full build plan, phase by phase, with the deviations from it recorded as they
happen: [`docs/PLAN.md`](docs/PLAN.md).

## Configuration

Settings layer as built-in defaults → `~/.agent/settings.json` →
`.agent/settings.json`, so a project can pin a model or point at an internal
proxy without touching globals. See
[`.agent/settings.example.json`](.agent/settings.example.json).

`AGENTS.md` / `CLAUDE.md` files — from the project root down to the working
directory, plus `~/.agent/` — are loaded into the system prompt as standing
project instructions.

Credentials come from the environment (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`,
...), or `HC_<PROVIDER>_API_KEY` for anything custom. Base URLs can be
overridden per provider with `HC_<PROVIDER>_BASE_URL`. Keys are read in exactly
one place and redacted before any error is printed.

## License

MIT
