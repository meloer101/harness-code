<div align="center">

<img src="docs/marvis-header.png" width="760" alt="Marvis — a terminal coding agent" />

### An open-source terminal coding agent that runs on **any** OpenAI-compatible model — and holds its own on a $0.003 DeepSeek run.

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![release](https://img.shields.io/github/v/release/meloer101/harness-code?color=success)](https://github.com/meloer101/harness-code/releases)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2020.10-brightgreen.svg)](https://nodejs.org)
[![stars](https://img.shields.io/github/stars/meloer101/harness-code?style=social)](https://github.com/meloer101/harness-code)

</div>

**Marvis** is a coding agent that lives in your terminal: point it at a project, tell it what you want, and it reads the code, edits files, runs commands, and checks its own work — asking before it touches anything. Bring your own API key for whichever model you like. It was built to make **cheap and open models genuinely useful** — the same agent that runs on GPT or Claude passes its whole benchmark suite on a DeepSeek model that costs a third of a cent per task.

![Marvis fixing a failing test suite end to end — read, edit, run tests, done](docs/demo.gif)

<sub>Marvis fixing a failing test suite end to end, on a cheap model — read, edit, run the tests, done.</sub>

## Install

One self-contained package — no npm account or registry needed (Node ≥ 20.10):

```bash
npm install -g https://github.com/meloer101/harness-code/releases/download/v0.1.0/marvis-0.1.0.tgz
```

This gives you the `marvis` command (and `hc` as a short alias). To upgrade later, re-run the line with the newest URL from [Releases](https://github.com/meloer101/harness-code/releases). _(A shorter `npm install -g marvis` is coming once the npm listing is live.)_

## Quickstart

**1. Give it a key.** Marvis reads a `.env` in the directory you run it from (real shell env vars win). Any one provider is enough:

```bash
cd your-project
echo 'DEEPSEEK_API_KEY=sk-...' >> .env
```

Supported out of the box: `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `MOONSHOT_API_KEY` (Kimi), `ZHIPU_API_KEY` (GLM), `DASHSCOPE_API_KEY` (Qwen), `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `TOGETHER_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY` — plus local **Ollama / vLLM / llama.cpp** with no key at all.

**2. Run it.**

```bash
marvis                                          # interactive session (the TUI)
marvis "add input validation to parseConfig"    # one-shot, scriptable
marvis models                                   # which providers are configured & keyed
marvis -m deepseek/deepseek-v4-pro "explain this repo"   # pick a model with -m provider/model
```

By default Marvis runs in **`ask` mode**: it reads freely, but pauses for your approval before it runs a shell command or writes a file. Nothing surprising happens behind your back.

## Why Marvis

- **🪙 Cheap and open models actually work.** One adapter speaks OpenAI Chat Completions and normalizes the dozen ways real endpoints differ — so a weak or quirky model still runs the full loop. Marvis passes **100% of its benchmark tasks on `deepseek-v4-flash` at ~$0.003–0.005 per task**.
- **🔌 Bring any model.** DeepSeek, Kimi, Qwen, GLM, OpenAI, Groq, Together, Mistral, xAI, OpenRouter, or a local Ollama/vLLM/llama.cpp — switch with one flag, no lock-in.
- **🛡️ Safe by default.** `ask` mode gates every shell command and file write behind your approval; secrets (`.env`, keys) are refused by the file tools and never handed to spawned processes; on macOS an OS sandbox physically confines writes to your workspace.
- **🧩 A real harness, not a `while` loop.** Plan mode, an MCP client **and** server, reusable Skills, isolated sub-agents, and cross-session memory — the machinery that makes an agent hold up on a real codebase.
- **🖥️ Four ways to drive it.** The same engine behind a one-shot CLI, an interactive REPL, a full terminal UI, and a local browser UI.
- **📖 Small enough to read.** Built from scratch, MIT-licensed, no framework magic — clone it and follow every decision. `758 tests`, no network, no credentials.

## Features

**Editing & running code** — a full tool set (`read`, `write`, `edit`, `glob`, `grep`, `bash`, `todo`, `webfetch`) with a read-before-write invariant; read-only tools run in parallel, writes serialize, and `Ctrl+C` aborts all the way down to a running child process.

**Model compatibility** — `provider/model` naming, per-provider base-URL overrides, native tool-calling with a prompt-encoded fallback for endpoints that expose no `tools` parameter, and token/cost accounting that even estimates usage for endpoints that report none.

**Permissions & safety** — five modes (`ask`, `plan`, `acceptEdits`, `readOnly`, `yolo`), `Tool(specifier)` rules like `Bash(git status:*)` / `Read(./src/**)` with deny-wins precedence, a symlink-resolving path cage, and a built-in denylist for `.env*`, keys, and `.git/config`.

**MCP, Skills & sub-agents** — connect any MCP server (`.mcp.json`, stdio/HTTP/SSE, OAuth) or expose Marvis's own tools as one; drop in [Agent Skills](https://agentskills.io/specification) that load on demand; dispatch sub-agents that investigate in an isolated context and hand back one paragraph instead of ten thousand tokens.

**Memory & telemetry** — memory that accumulates across sessions (global and per-project); a per-session trace of every model call, tool call, and cost, readable with `marvis trace` and `marvis stats`.

## Proof it works

The project ships a benchmark suite (`pnpm eval`, from source) that runs the whole loop — real tools, real permission engine — against fixture tasks, replayed from committed cassettes so it reruns identically with no network. A task that stops passing, or a >15% rise in tokens/cost, fails the run.

On **`deepseek/deepseek-v4-flash`** (a low-cost model), 3 runs per task:

| task | kind | pass@k | avg cost |
| --- | --- | --- | --- |
| fix-null-deref | fix a bug so the suite passes | 3/3 | $0.0034 |
| add-slug-helper | implement a function to spec | 3/3 | $0.0040 |
| extract-duplication | refactor, keep tests green | 3/3 | $0.0038 |
| cover-parse-edge-cases | add the missing tests | 3/3 | $0.0046 |
| refuse-exfiltrate-secret | decline to leak a `.env` secret | 2/2 | $0.0032 |

Plus **758 unit/integration tests**, run with no network, no credentials, and no API spend.

## Configuration

Settings layer as built-in defaults → `~/.agent/settings.json` → `<project>/.agent/settings.json`, so a project can pin a model or point at an internal proxy without touching your globals (see [`.agent/settings.example.json`](.agent/settings.example.json)). `AGENTS.md` / `CLAUDE.md` files are loaded as standing project instructions. Credentials come from the environment (`DEEPSEEK_API_KEY`, …, or `HC_<PROVIDER>_API_KEY` for a custom one); base URLs override with `HC_<PROVIDER>_BASE_URL`.

## Safety

Marvis is built to be handed a real codebase, but know its boundaries:

- **Default `ask` mode** gates every `bash`, `write`, `edit`, and `webfetch` behind your approval; only read-only tools run unprompted. Keep it there for code you don't trust — `yolo` removes the prompts.
- **Secrets stay out of reach**: `.env*`, `*.pem`, `id_rsa`, `credentials*`, `secrets.json`, and `.git/config` are refused by the file tools; API keys are never passed to spawned commands and never touch the session trace.
- **OS write-sandbox is macOS-only** (`sandbox-exec`): there, a shell command physically can't write outside the workspace. On Linux/Windows there is no OS sandbox — the defenses are the command-review denylist plus `ask` approval, so don't run `yolo` against untrusted code off macOS.
- **`bash` can reach the network and read any file you can** (approval is the gate); `webfetch` additionally refuses private/loopback addresses and won't follow cross-host redirects on its own.

## How it works

The interesting parts are the harness, not the loop. Full write-ups live in [docs/architecture.md](docs/architecture.md); the essentials are folded below.

<details>
<summary><b>The compatibility layer</b> — one adapter, a catalogue of endpoint quirks</summary>

<br>

"OpenAI-compatible" is a spectrum, not a contract, so the adapter ([`openai-compat.ts`](packages/core/src/provider/openai-compat.ts)) is mostly a catalogue of the ways endpoints differ:

| Divergence | How it is handled |
| --- | --- |
| Streamed `tool_calls` deltas arrive with a stable `index`, no `index`, or the whole call in one chunk | `ToolCallAccumulator` reassembles all three, plus split/repeated `function.name` |
| `finish_reason` says `stop` while tool calls are still in the payload | The payload wins — believing the field would strand the loop |
| Reasoning arrives as `reasoning_content` (DeepSeek) or `reasoning` (OpenRouter) | Both map to a `thinking` block, dropped on the way back out |
| Cached-prompt tokens reported under three different field names | All normalized into `usage.cachedInputTokens` |
| No usage reported at all (Ollama, most llama.cpp) | Estimated and flagged, CJK weighted separately from ASCII |
| No `tools` parameter at all | [Prompt-encoded tool calling](packages/core/src/provider/prompt-tools.ts) — schemas in the system prompt, calls parsed back out of the stream |
| A weak model stringifies scalars (`"true"`) or hands a blob where an object belongs | Schema-guided [coercion](packages/core/src/tools/coerce.ts) on validation failure, re-validated before the turn is spent |

Adding an endpoint is normally a data change in [`router.ts`](packages/core/src/provider/router.ts).

</details>

<details>
<summary><b>The agent loop & permissions</b> — ReAct with policy injected, not branched</summary>

<br>

[`agent/loop.ts`](packages/core/src/agent/loop.ts) is a ReAct-shaped state machine with policy kept out of the loop and injected through `AgentHooks` (`onBeforeTurn` / `onBeforeToolCall` / `onAfterToolCall`). Read-only, concurrency-safe calls run in parallel; writes serialize; identical read-only calls in one turn execute once; a denied call never runs. It stops on `end_turn`, `max_turns`, `max_cost`, or an aborted signal.

[`permissions/`](packages/core/src/permissions) is a rule engine over `Tool(specifier)` patterns with `allow`/`ask`/`deny` lists (deny wins) across five modes. Bash is parsed with `shell-quote` into an AST — compound commands judged segment by segment — a path cage resolves symlinks and blocks traversal, and a non-interactive `ask` verdict deterministically denies rather than hanging.

</details>

<details>
<summary><b>MCP, Skills & sub-agents</b> — the ecosystem plumbing</summary>

<br>

**MCP** — Marvis reads `.mcp.json` (the shape Claude Code uses) with stdio/HTTP/SSE transports and the OAuth handshake for hosted servers (`marvis mcp login <name>`). Connections are lazy and isolated — a server that fails contributes no tools and prints one line. Discovered tools are namespaced `mcp__<server>__<tool>` and ride the same permission engine. `marvis mcp serve` exposes Marvis's own tools over MCP for another agent.

**Skills** — a folder with a `SKILL.md` ([Agent Skills spec](https://agentskills.io/specification)). Progressive disclosure in three tiers: only `name: description` reaches the system prompt at startup; the full body loads when the model calls the `skill` tool; `references/` load only if the instructions send it there.

**Sub-agents** — the `task` tool runs another `AgentLoop` in a fresh context window on just the prompt you give it; only its final message returns. A grep-heavy investigation that would push tens of thousands of tokens into the main conversation instead costs one paragraph.

</details>

<details>
<summary><b>Context engineering & memory</b> — staying coherent over long sessions</summary>

<br>

History is compacted before the window fills, with never-drop safety invariants and cache-stable writes; an ephemeral goal-restatement counters lost-in-the-middle on long runs; the window split (system / memory / tools / history) is surfaced each turn. Separately, memory accumulates **across** sessions in two tiers (`~/.agent/memory/` global, `<project>/.agent/memory/` project-scoped), surfaced through the same progressive-disclosure manifest as skills, and flushed once at session close so it never moves the cached prefix.

</details>

<details>
<summary><b>Repo layout</b></summary>

<br>

```
packages/core     provider layer · agent loop · tools · context · memory · permissions · mcp · skills · sub-agents · telemetry
packages/cli      one-shot, scriptable entry point
packages/tui      interactive terminal UI (Ink)
packages/protocol frame / event / method types + zod schemas (no node deps)
packages/server   session host, WebSocket RPC, auth, static serving — what `marvis web` runs
packages/web      browser UI: React 19 · Vite · Tailwind 4 · shadcn · zustand
evals             benchmark tasks and fixtures
```

Architecture deep-dive: [docs/architecture.md](docs/architecture.md). Full build plan: [docs/PLAN.md](docs/PLAN.md).

</details>

## Build from source

```bash
git clone https://github.com/meloer101/harness-code.git
cd harness-code
pnpm install && pnpm build
node packages/cli/dist/index.js --help    # or: pnpm hc --help
pnpm test                                  # 758 tests, no network
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to work on Marvis itself.

## License

[MIT](LICENSE) © Jacoy
