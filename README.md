# harness-code

A coding agent built from scratch — MCP client and server, skills, plan mode,
and the harness engineering underneath: context management, a permission
sandbox, sub-agents, and an eval suite that measures whether any of it works.

> Status: **Phase 1 of 10**. The provider compatibility layer is complete and
> tested. The agent loop, tools, permissions, context engineering, MCP, skills,
> plan mode, sub-agents, telemetry and the TUI are in progress — see
> [the plan](#roadmap).

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
node packages/cli/dist/index.js raw "explain async generators" -m deepseek/deepseek-chat
node packages/cli/dist/index.js doctor          # resolved settings and their sources
```

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

## Testing

101 tests, no network, no credentials, no API spend:

```bash
pnpm test
```

Provider behaviour is tested through injected transports — synthesized SSE
frames for stream assembly, and a record/replay cassette for anything that once
came from a real endpoint. Determinism here is a prerequisite for the eval
suite in Phase 8: a benchmark you cannot re-run identically cannot tell you
whether last week's change helped.

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
| 2 | Agent loop and tools | next |
| 3 | Permissions and sandbox | |
| 4 | Context engineering — compaction, read ledger, cache stability | |
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

Credentials come from the environment (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`,
...), or `HC_<PROVIDER>_API_KEY` for anything custom. Base URLs can be
overridden per provider with `HC_<PROVIDER>_BASE_URL`. Keys are read in exactly
one place and redacted before any error is printed.

## License

MIT
