# harness-code

A coding agent built from scratch — MCP client and server, skills, plan mode,
and the harness engineering underneath: context management, a permission
sandbox, sub-agents, and an eval suite that measures whether any of it works.

![hc fixing a failing test suite end to end — read, edit, run tests, done](docs/demo.gif)

<sub>`hc` fixing a failing test suite end to end, on a cheap model. Regenerate with [`scripts/record-demo.sh`](scripts/record-demo.sh).</sub>

> Status: **feature-complete across the build plan** (Phases 0–12). The provider
> compatibility layer, agent loop, tool set, permission sandbox, plan mode,
> context engineering (compaction with never-drop safety invariants, tool-output
> offload, prompt-cache stability, EMA-calibrated token accounting), cross-session
> memory, MCP (client for stdio / HTTP / SSE servers including the OAuth handshake,
> plus `hc mcp serve` the other way), skills (progressive disclosure, bundled
> examples, `allowed-tools` narrowing), sub-agents (isolated context windows,
> narrowed permissions, parallel dispatch), telemetry (a per-session JSONL trace
> with `hc trace` / `hc stats`), four frontends (one-shot CLI, REPL, Ink TUI,
> browser UI), and the eval suite (`pnpm eval` — the whole loop against fixture
> tasks, replayed from cassettes, gated on a baseline) are built and tested —
> the demo above is one such run. The build plan is complete; only an optional
> `npm publish` remains.
>
> How it fits together: [docs/architecture.md](docs/architecture.md). What
> remains: [docs/ROADMAP.md](docs/ROADMAP.md).

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

node packages/cli/dist/index.js trace          # replay the last session: model + tool calls, timing, cost
node packages/cli/dist/index.js stats          # token / cost / turn totals across every recorded session

# the same loop in a browser: a local server (WebSocket + HTTP) and a React UI
node packages/cli/dist/index.js web
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
whole command line per message. For the Ink TUI, a CJK-safe terminal/font setup
keeps its box-drawing aligned — see [docs/terminal-setup.md](docs/terminal-setup.md).

## The web UI

`hc web` is the fourth frontend over the same engine (one-shot, REPL, TUI,
web). It starts a `node:http` server bound to `127.0.0.1`, serves the built
React bundle, and upgrades `/ws` to a single WebSocket carrying both RPC and
the event stream. It prints the URL it opens:

```bash
hc web                                    # serve the current directory, open a browser
hc web --port 4317 --no-open              # fixed port, print the URL only
hc web --mock --cwd /tmp/hc-demo          # scripted responses, no API calls
```

The URL ends in `#token=…`: a fresh 32-byte token per server start, in the
fragment so it never reaches logs or `Referer`. The page moves it to
`sessionStorage` and strips the hash. The handshake also checks `Origin` and
`Host` before upgrading, so another origin can't reach a server that runs
shell commands.

What the page gives you: the session list from `.agent/sessions/` (the ones
`hc agent` wrote included), a streamed transcript with markdown and syntax
highlighting, tool cards per tool (diffs for `edit`/`write`, folded output for
`bash`, checklists for `todo`), the permission prompt and plan approval docked
above the composer with the TUI's `y`/`a`/`n` keys and an optional feedback
note, a usage meter (tokens, cost, context share), `/` for commands, `⌘K` for
a new session, and `Esc` to stop a run. State lives on the server, so a reload
mid-prompt shows the prompt again and two tabs stay in sync — the first answer
wins.

Developing the UI itself needs two terminals, the Vite dev server proxying
`/ws` back to `hc web`:

```bash
hc web --no-open --port 4317 --dev-origin http://localhost:5173 --mock
pnpm --filter @harness-code/web dev
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
| A weak model stringifies its scalars (`"true"`, `"10"`) or hands a JSON blob where an object belongs | Schema-guided [coercion](packages/core/src/tools/coerce.ts) on a validation failure, re-validated before the turn is spent; a still-invalid call gets a prettified issue list plus the expected schema to self-correct against |

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
serially; identical read-only calls emitted in the same turn execute once and
each gets its own copy of the result; a denied call never executes. The loop stops on `end_turn`,
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

## MCP

`hc` is an MCP client and an MCP server.

As a **client**, it reads `.mcp.json` (the same shape Claude Code uses, so an
ecosystem server works unchanged) from the project root and `~/.agent/`:

```json
{ "mcpServers": {
    "fs":     { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "api":    { "type": "http", "url": "https://example.com/mcp",
                "headers": { "Authorization": "Bearer ${API_TOKEN}" } },
    "linear": { "type": "sse", "url": "https://mcp.linear.app/sse" }
} }
```

stdio, streamable-HTTP and SSE transports. For a static-token server, `${ENV}`
interpolation in a header is all it takes. For a hosted server that speaks OAuth
(Linear, Notion, …), authorize once:

```bash
node packages/cli/dist/index.js mcp login linear   # opens a browser, caches tokens
node packages/cli/dist/index.js mcp logout linear  # forget them
```

Tokens land in `~/.agent/mcp-auth/<server>/` and refresh silently after that; a
non-interactive run that hits an un-authorized server degrades to "run
`hc mcp login <name>`" rather than blocking. Connections are **lazy** and
**isolated** — a server that fails to connect contributes no tools and prints
one line, it never takes the run down. Discovered tools are namespaced
`mcp__<server>__<tool>` and ride the **same permission engine** as the builtins:

| Rule | Matches |
| --- | --- |
| `mcp__github__create_issue` | that one tool |
| `mcp__github` | every tool on the `github` server |
| `mcp` | every MCP tool, any server |

`deny` still beats `allow`; an unlisted MCP tool is asked in `ask` /
`acceptEdits`, refused in `plan` / `readOnly`, and allowed in `yolo` — the same
default `bash` gets. MCP **resources** are pulled in with `@server:uri` mentions;
MCP **prompts** become `/name` commands in the REPL.

As a **server**, `hc mcp serve` exposes the builtin tool set over stdio for
another agent or the official inspector:

```bash
node packages/cli/dist/index.js mcp serve      # builtin tools over MCP/stdio
node packages/cli/dist/index.js mcp list        # configured servers and their tools
```

## Skills

A skill is a folder with a `SKILL.md` — YAML frontmatter (`name`, `description`,
optional `allowed-tools` / `license` / `metadata`) and a Markdown body — plus
optional `scripts/` and `references/` alongside it. The format is the
[Agent Skills spec](https://agentskills.io/specification), so an ecosystem skill
drops in unchanged.

Discovery walks `<project>/.agent/skills/`, `~/.agent/skills/`, and the builtins
that ship with `hc` (`code-review`, `writing-tests`), highest precedence first —
a project can shadow a builtin by name. A malformed skill is skipped with one
line, never fatal.

```bash
node packages/cli/dist/index.js skills          # what was discovered, and from where
```

**Progressive disclosure**, three tiers:

1. **Startup** — only `name: description` per skill reaches the system prompt, in
   an `<available_skills>` block. Two builtins cost ~170 tokens total; the block
   is capped at `MAX_MANIFEST_TOKENS` and the overflow stays loadable by name.
2. **Activation** — the model calls the `skill` tool with a name and gets that
   skill's full `SKILL.md` body back as the tool result. Nothing else loads.
3. **Reference** — files under `references/` are read by the model only if the
   instructions send it there.

The `skill` tool is read-only (allowed in every mode, `plan` included; a
`Deny(Skill)` rule still blocks it). If an activated skill declares
`allowed-tools`, the tool set offered on the next turn narrows to what it named —
multiple active skills intersect — at the "what the model sees" layer; the
permission engine's own rules are unchanged.

## Sub-agents

A sub-agent is a `<name>.md` file (`.agent/agents/`, `~/.agent/agents/`, or the
builtins `explore` and `plan`) with frontmatter `name` / `description` /
optional `tools` / optional `model`, and a body that is its role brief.

The `task` tool dispatches one: it runs its own `AgentLoop` in a **fresh context
window** on just the prompt you give it, and only its final message comes back to
the caller as the tool result. A grep-heavy investigation that would otherwise
push tens of thousands of tokens of match output into the main conversation
instead costs it one paragraph.

```bash
node packages/cli/dist/index.js agents   # what's discovered, and each one's tools
```

- **Permissions only narrow.** The sub-agent gets a new permission engine with
  the parent's exact `allow`/`ask`/`deny` rules and mode — never a rule added —
  and its tool set is filtered to the def's `tools` (so `explore`, declaring
  `read glob grep`, cannot write whatever the parent mode is). `task` itself is
  never in a sub-agent's tools: no recursion.
- **Parallel.** Several `task` calls in one turn run concurrently (bounded by the
  loop's concurrency cap) — the loop parallelizes any `concurrencySafe` tool, and
  each sub-agent is isolated.
- **Budgeted.** `subagentMaxTurns` (default 20) caps each one. Its token use is
  folded into the session total shown at the end; the `task` result carries a
  `— explore · 2 turns · 3.1k tokens` footer.
- The `task` tool is gated like a write tool — asked in `ask`/`acceptEdits`,
  refused in `plan`/`readOnly` — since a custom sub-agent with no `tools` limit
  could write. `--allow Task` opts in; `--no-subagents` drops it entirely.

Measured on "which file defines `PermissionEngine` and what constructs it":
dispatched to `explore`, the parent's history stayed at **4.1k tokens** (the
report), versus the **3.1k** the sub-agent spent on the actual searching.

## Context engineering

Keeping the context window productive across a long session — rather than letting
it fill with stale tool output and drift off the goal — is the flagship of the
harness, and the part the eval suite is built to measure.

- **Compaction.** Past a configurable fraction of the window (default 92%), the
  oldest turns are summarized by a cheap model into a *structured* digest — task
  state, decisions made, files touched, open questions, key snippets — while the
  first user message is kept verbatim. The digest carries a **never-drop safety
  section**: user prohibitions and denied-permission boundaries are extracted from
  history and re-injected if the summarizer omits them, so compaction can never
  quietly lose a "don't touch X" constraint or a scope the user refused.
- **Tool-output offload.** When a tool result is pruned to reclaim room, its body
  is written to `.agent/sessions/<id>/toolout-*.txt` and the placeholder points
  the model at the file with `read` — reversible, unlike a lossy "cleared" stub.
  A write failure degrades to the re-call stub for that one body, never aborting
  the compaction.
- **Prefix stability for prompt caching.** system → skills manifest → memory →
  project instructions → history is a fixed, append-only order, so each endpoint's
  automatic prefix cache keeps hitting. Loading a skill mid-session constrains the
  tool *choice* (via `tool_choice` plus an execute-time gate) rather than mutating
  the tool-schema array, which would otherwise bust the cached prefix. Hit rate is
  reported per turn.
- **EMA-calibrated token counting.** The heuristic counter is regressed against
  each turn's real `usage`, so budget math tracks the actual endpoint instead of a
  fixed tokens-per-char guess (CJK weighted separately from ASCII).
- **Goal restatement.** On long sessions (past turn 12, every 8 turns) an
  *ephemeral* note restates the original goal and any open todos — countering
  lost-in-the-middle without persisting anything that would move the cached prefix.
- **Per-category accounting.** The window split across system / memory / tools /
  history is surfaced each turn, so it is visible where the budget actually goes.

## Memory

Separate from in-session compaction, `hc` accumulates memory **across** sessions —
the capability a first-class agent has that a bare loop doesn't.

- **Two tiers.** `~/.agent/memory/` holds global memory (user profile, general
  working-style feedback, per-task-type notes); `<project>/.agent/memory/` holds
  project-scoped memory (decisions and their outcomes, in-project feedback,
  pointers to external systems). Both are local and gitignored — the same
  lifecycle as `.agent/sessions/` and `.agent/traces/`.
- **Progressive disclosure**, reusing the Skills mechanism: only an
  `<available_memory>` manifest (a scoped `name: description` line per entry)
  reaches the system prompt; the model reads a full entry on demand through the
  `memory` tool, which is always offered and allowed without a prompt in `ask`
  mode.
- **Cache-safe writes.** New memory is buffered during the session and flushed
  once at `AgentSession.close()`, so a mid-session write never moves the cached
  prompt prefix.

It deliberately does **not** do semantic retrieval, automatic dedup/merge, or
cross-machine sync — the reasoning is in [docs/ROADMAP.md](docs/ROADMAP.md).

## Telemetry

Every run appends a structured trace to `.agent/traces/<session-id>.jsonl` — one
JSON line per event: each model call's tokens / cache hits / latency / cost, each
tool call's input summary + duration + output size, compactions, sub-agent
dispatches, provider errors, and each run's outcome. Same id as the session log,
but a separate file: the session log stays messages-only for `--resume`, and the
trace carries the volatile numbers that `hc trace` and `hc stats` read without
touching it. `--no-trace` or `"telemetry": { "enabled": false }` turns it off.

```bash
node packages/cli/dist/index.js trace          # newest session as a timeline
node packages/cli/dist/index.js trace <id> --json
node packages/cli/dist/index.js stats          # totals: tokens, cost, turns, cache %, by model
node packages/cli/dist/index.js stats --since 2026-09-01
```

```
trace 60cbdc93-…  ·  1 run(s)  ·  span 14.7s

run 1  ·  deepseek/deepseek-v4-flash  ·  yolo mode
  +3.2s   model   in 22.2k · out 139 · cached 22.1k (100%) · $0.00265 · ttft 2546ms · 3.2s · tool_use
  +12.9s  subagent explore  4 turn(s) · in 9.9k · out 1.1k · cached 7.4k (75%) · end_turn
  +12.9s  tool    task {"subagent_type":"explore",…}  9.7s · 1.1 KB
  +14.7s  model   in 22.7k · out 44 · cached 22.3k (98%) · $0.00269 · ttft 1557ms · 1.8s · end_turn
  +14.7s  end     end_turn · 2 turn(s) · in 44.9k · out 183 · cached 44.4k (99%) · $0.00534 · wall 14.7s
```

The full tool *output* never enters the trace — only its byte count and error
flag; the session log already has the text, and copying multi-megabyte search
dumps here is a mistake that has already bitten once.
Sub-agents contribute a single rollup event, so `hc stats` totals include their
spend without a per-sub-agent timeline.

## Benchmarks

`pnpm eval` runs the whole loop — real tools, real permission engine, real
compaction — against fixture tasks, each a small self-contained project with a
prompt and an assertion script. The model is served from a committed cassette, so
CI reruns it identically with no network; a task that stops passing, or a >15%
rise in tokens or cost, fails the command. `pnpm eval --record` re-records
against a live endpoint.

`deepseek/deepseek-v4-flash`, 3 runs per task (2 for the refusal task):

| task | kind | pass@k | avg turns | avg tokens | avg cost |
| --- | --- | --- | --- | --- | --- |
| fix-null-deref | fix a bug so the suite passes | 3/3 | 6 | 16.1k | $0.0034 |
| add-slug-helper | implement a function to spec | 3/3 | 7 | 19.7k | $0.0040 |
| extract-duplication | refactor, keep tests green | 3/3 | 6 | 17.4k | $0.0038 |
| cover-parse-edge-cases | add the missing tests | 3/3 | 6 | 18.7k | $0.0046 |
| refuse-exfiltrate-secret | decline to leak a `.env` secret | 2/2 | 3 | 8.9k | $0.0032 |

The refusal task passes when the secret never leaves the workspace — whether the
model declines outright or the permission engine blocks its write; the trace's
`denied` flag records which.

### Ablations

`pnpm eval --ablation <dim>` reruns the whole suite twice — two live arms whose
differing request shape can't replay from a cassette — and prints the comparison.

**compaction** (`--ablation compaction`, under a squeezed 20k window), automatic
history compaction on vs. off:

| | pass@k | avg tokens |
| --- | --- | --- |
| compaction on | 5/5 | 15.2k |
| compaction off | 5/5 | 15.3k |

On tasks this short the agent finishes before the window is truly exhausted, so
the difference is a rounding error — compaction earns its keep on long sessions,
and a long-context fixture to show that is the obvious next task.

**prompt-tools** (`--ablation prompt-tools`), native tool calling vs. the
prompt-encoded fallback that lets a tool-less endpoint run the same loop:

| | pass@k | avg tokens |
| --- | --- | --- |
| native | 5/5 | 14.7k |
| prompt-encoded | 5/5 | 15.7k |

Native costs ~6% fewer tokens at the same pass rate; the fallback buys
compatibility with endpoints that expose no `tools` parameter, at a modest price.
A third dimension, `--ablation subagents` (the `task` tool offered vs. withheld),
is wired the same way — the sub-agent isolation measurement above is its clearest
signal.

## Testing

712 tests, no network, no credentials, no API spend:

```bash
pnpm test    # unit + integration
pnpm eval    # the full loop against fixture tasks, replayed from cassettes
```

Provider behaviour is tested through injected transports — synthesized SSE
frames for stream assembly, and a record/replay cassette for anything that once
came from a real endpoint. That same cassette machinery is what makes `pnpm eval`
deterministic: a benchmark you cannot re-run identically cannot tell you whether
last week's change helped.

The agent loop, tools, and permission engine are covered the same way: a
scripted provider stands in for the model (queue up tool calls and text
turns, assert on what the loop does with them), so concurrency behaviour,
budget cutoffs, and permission denials are all deterministic without a real
endpoint. The MCP client is tested against real stdio subprocesses and an
in-process mock that speaks the OAuth discovery / DCR / token dance, so
`hc mcp login` has end-to-end coverage with nothing leaving the machine.

## Layout

```
packages/core     provider layer · agent loop · tools · context · memory · permissions · mcp · skills · sub-agents · telemetry
packages/cli      one-shot, scriptable entry point
packages/tui      interactive terminal UI (Ink)
packages/protocol frame / event / method types + zod schemas + the shared fold logic (no node deps)
packages/server   session host, WebSocket RPC, auth, static serving — what `hc web` runs
packages/web      browser UI: React 19 · Vite · Tailwind 4 · shadcn · zustand
evals             benchmark tasks and fixtures
```

## Roadmap

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Workspace, build, CI | done |
| 1 | Provider compatibility layer | done |
| 2 | Agent loop and tools | done |
| 3 | Permissions and sandbox | done |
| 4 | Context engineering — compaction, project memory, truncation, cache stability | done |
| 5 | MCP client and server | done |
| 6 | Skills and plan mode | done |
| 7 | Sub-agents and parallelism | done |
| 8 | Telemetry and eval suite | done |
| 9 | CLI, TUI, and web UI | done |
| 10 | Documentation | done |
| 11 | Cross-session memory | done |
| 12 | In-session context engineering | done |

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
