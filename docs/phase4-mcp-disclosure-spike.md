# Spike: progressive disclosure for MCP tools (hybrid policy)

**Status:** spike complete, runtime wiring not yet built. Nothing in this spike is
imported by the agent loop, so it changes no prompt bytes and no eval cassettes.

## Problem

Every discovered MCP tool's full JSON Schema ships in the tool payload **every
turn** (`McpHub.toolSpecs` → `ToolRegistry` → request). Skills are disclosed
progressively (a `name: description` manifest, full body loaded on demand); MCP
tools have no equivalent. With several servers configured this is a large fixed
per-turn cost and dilutes tool selection.

## Approach (hybrid)

`McpToolCatalog` (`packages/core/src/mcp/tool-catalog.ts`) partitions discovered
MCP tools:

- **inline** — full schemas, registered as today. Small servers
  (≤ `inlineServerMaxTools`, default 10) stay inline until a token budget
  (`maxInlineTokens`, default 4000) is spent, so the common one/two-small-server
  setup pays **no round-trip**.
- **deferred** — advertised name + one-line description via an
  `<available_mcp_tools>` manifest; the model loads a specific tool's full schema
  on demand before calling it.

## Measured saving

`tool-catalog.test.ts` measures a representative "power user" setup — Linear (6),
Slack (8), GitHub (30), Notion (40), Gmail (25), Calendar (12) = **121 tools**,
heuristic token count:

| | tokens / turn |
|---|---|
| all-inline (today) | **18,816** |
| hybrid (14 inline + 107 deferred manifest) | **4,359** |
| **saved** | **14,457 (77%)** |

The manifest (2,197 tok) is a small fraction of the 16k+ tokens of schemas it
replaces. The saving is per turn; even with prompt caching it counts against the
context window and dilutes selection every turn.

## What the runtime build still needs (not in this spike)

1. **`mcp_tool_search`/load tool** — takes a query or explicit names, returns the
   full schemas, and `register()`s the chosen deferred specs into the live
   `ToolRegistry` the loop already holds (the loop reads `this.opts.tools` each
   turn, so a mid-run register takes effect next turn — `#buildLoop` runs once per
   `run()`).
2. **Prompt segment behind a flag** — an optional `<available_mcp_tools>` block in
   `buildAgentSystemPrompt`, present only when the flag is on and tools defer.
   Off by default keeps prompt bytes (and cassettes) unchanged.
3. **Cache stability** — the deferred manifest must be byte-stable within a
   session (as skills are); loading a tool must append, never rewrite earlier
   cached segments.
4. **Eval** — a multi-server MCP fixture to confirm tool-selection quality doesn't
   regress, then a deliberate cassette re-record in its own commit.

## Recommendation

The token saving is large enough to justify the runtime build. Gate the eval on a
multi-server fixture (the current eval fixtures configure no MCP servers), and land
the prompt-changing part as an isolated, cassette-re-recording commit.
