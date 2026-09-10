# Web UI: server protocol design

`hc web` starts a local server that hosts `AgentSession`s and serves a browser
UI. It is the fourth frontend over the same engine (one-shot, REPL, TUI, web);
a later Electron shell loads the same web bundle and embeds the same server.
Reference architecture: t3code (`apps/server` + `apps/web` + `apps/desktop`),
opencode (`packages/server` + `packages/app` + `packages/desktop`).

Status: design, not yet implemented. Build plan: [web-frontend.md](web-frontend.md).

## What core already gives us

`AgentSession` (`core/src/agent/session-runner.ts`) is already renderer-agnostic —
the TUI proves it. Everything the web frontend needs is an existing seam:

| need | core seam |
| --- | --- |
| token / tool stream | `onEvent(AgentEvent)` — `text_delta`, `thinking_delta`, `tool_call_start/end`, `turn_end`, `turn_retry`, `context`, `compaction`, `stop` |
| status lines | `onNotice(Notice)` — `{ kind, level, text, data? }` |
| permission prompt | `askHandler(req) → Promise<PermissionDecision>`, settles as deny on `req.signal` abort |
| plan approval | `confirm({ title, body }) → Promise<{ approved, feedback? }>` |
| control | `runTurn`, `abort`, `setMode`, `compactNow`, `expandSlash`, `listSlashCommands`, `close` |
| state | `messages`, `mode`, `sessionUsage`, `contextSnapshot`, `mcpStatus`, `activeSkills` |
| history | `listSessionIds`, `loadSession`, `resumeId` |
| "always allow" | `session.engine.addAllowRule(toolName)` (session-scoped, same as TUI) |

The server is therefore mostly a *bridge*: `UiStore` (`tui/src/state/bridges.ts`)
turned into a network-facing registry of pending asks, plus a socket.

## Topology

```
browser (React)  ──WS /ws  (RPC + events)──►  hc server (node:http + ws)
                 ──HTTP GET /*  (static)──►        │
                                                    ├─ SessionHost(id) ─ AgentSession
                                                    ├─ SessionHost(id) ─ AgentSession
                                                    └─ …   one workspace (cwd) per server
```

- **One workspace per server** (the `cwd` of `hc web`). Multi-workspace is a
  sidebar feature for later; it is N of these, not a protocol change.
- **Many sessions per workspace**, each an `AgentSession` wrapped in a
  `SessionHost` that owns: the event log, pending ask/plan, busy flag.
- **One run at a time per session.** `runTurn` has no guard of its own; the
  host rejects `session.send` while busy (UI disables the composer). A queue
  can come later.
- Sessions keep running when the tab closes. A host is disposed on
  `session.close` or server shutdown, never on client disconnect.

## Transport

A single WebSocket per tab carries everything after the page loads. One socket
means one auth check, one ordering guarantee, and no REST/WS race between "I
sent a message" and "the first token arrived". Plain HTTP only serves the
static bundle.

Frames are JSON:

```ts
// client → server
type ClientFrame = { t: 'req'; id: number; method: string; params: unknown };

// server → client
type ServerFrame =
  | { t: 'res'; id: number; ok: true; result: unknown }
  | { t: 'res'; id: number; ok: false; error: { code: ErrorCode; message: string } }
  | { t: 'evt'; sessionId: string; seq: number; event: WireEvent };

type ErrorCode = 'unauthorized' | 'not_found' | 'busy' | 'bad_request' | 'internal';
```

Client params are validated with zod on the server (core already depends on it).

### Delta coalescing

`onEvent` fires once per token. The host buffers consecutive `text_delta` /
`thinking_delta` and flushes them as one event every ~30 ms, and **immediately**
before any non-delta event — the same rule as the TUI's `EventBuffer`, moved to
the server so the socket and React both see ~30 frames/s instead of hundreds.
Ordering is preserved: a coalesced delta is always sent before the event that
forced the flush.

## Events

```ts
type WireEvent =
  // AgentEvent, forwarded verbatim (deltas coalesced as above)
  | AgentEvent
  // Notice, forwarded verbatim
  | { type: 'notice'; notice: Notice }
  // run lifecycle — brackets one runTurn()
  | { type: 'run_start'; runId: string; input: string }
  | { type: 'run_end'; runId: string; stopReason: AgentStopReason; usage: Usage; sessionUsage: Usage }
  | { type: 'run_error'; runId: string; message: string }
  // human-in-the-loop
  | { type: 'ask'; askId: string; toolName: string; input: unknown; reason: string }
  | { type: 'plan'; planId: string; title: string; body: string }
  | { type: 'resolved'; requestId: string; by: 'user' | 'abort' }
  // state changes not otherwise visible
  | { type: 'mode'; mode: PermissionMode };
```

`turn_retry` keeps its core meaning: deltas since the last `context` event are
void. Clients fold events with the same logic as `EventBuffer`.

## Methods

| method | params | result |
| --- | --- | --- |
| `server.info` | — | `{ version, cwd, projectRoot, defaultModel, models[], modes[] }` |
| `session.list` | — | `SessionSummary[]` newest first |
| `session.create` | `{ model?, mode? }` | `SessionSnapshot` |
| `session.open` | `{ id }` | `SessionSnapshot` (resumes from disk if not live) |
| `session.subscribe` | `{ id, sinceSeq? }` | `{ lastSeq }` or `{ reset: true, snapshot }` |
| `session.unsubscribe` | `{ id }` | — |
| `session.send` | `{ id, text }` | `{ runId }`; `busy` error if a run is active |
| `session.abort` | `{ id }` | — |
| `session.setMode` | `{ id, mode }` | — |
| `session.compact` | `{ id }` | `{ tokensBefore, tokensAfter } \| null` |
| `session.slashCommands` | `{ id }` | `SlashCommandInfo[]` |
| `session.close` | `{ id }` | — |
| `ask.answer` | `{ sessionId, askId, decision: 'once' \| 'always' \| 'deny', feedback? }` | — |
| `plan.answer` | `{ sessionId, planId, approved, feedback? }` | — |

```ts
interface SessionSummary {
  id: string;
  mtimeMs: number;
  title: string;          // first user message, truncated
  live: boolean;          // has a SessionHost in memory
  running: boolean;
  pending: boolean;       // waiting on an ask/plan — the sidebar badge
}

interface SessionSnapshot {
  id: string;
  modelRef: string;
  mode: PermissionMode;
  transcript: Message[];  // full display history — see "Transcript vs. context"
  usage?: Usage;
  context?: ContextSnapshot;
  running: boolean;
  pendingAsk?: { askId: string; toolName: string; input: unknown; reason: string };
  pendingPlan?: { planId: string; title: string; body: string };
  lastSeq: number;
}
```

`session.send` handles slash input server-side so every client behaves the
same: `/compact` → `compactNow`, `/plan` → `setMode('plan')`, MCP prompts →
`expandSlash` then run. Pure-UI commands (`/help`, `/clear`) never reach the
server.

## Reconnect and multiple tabs

- Every event gets a per-session monotonic `seq`. The host keeps a ring buffer
  of the current run's events (bounded, e.g. 5 000 frames).
- On reconnect the client calls `session.subscribe { id, sinceSeq }`. If the
  buffer still covers `sinceSeq` the server replays the gap; otherwise it
  answers `{ reset: true, snapshot }` and the client rebuilds from scratch.
- Pending ask/plan live on the host, not the socket, so a reload mid-prompt
  shows the prompt again (it is in the snapshot). With two tabs open, the first
  answer wins and both get `resolved`.
- Abort (`session.abort`, or the run's signal) settles a pending ask as deny —
  existing `askHandler` contract — and emits `resolved { by: 'abort' }`.

## Security

The server hosts a tool that runs arbitrary shell commands. A browser page on
any other origin must not be able to reach it.

1. **Bind `127.0.0.1` only.** No `--host` flag in v1.
2. **Random token per server start** (32 bytes, `crypto.randomBytes`). `hc web`
   opens `http://127.0.0.1:<port>/#token=<t>` — in the fragment, so it never
   hits logs or `Referer`. The client moves it to `sessionStorage` and strips
   the hash.
3. **WS handshake checks** before upgrade: `Origin` must equal the server's own
   origin, `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (DNS
   rebinding), and the first frame must be `{ method: 'auth', params: { token } }`
   compared with `timingSafeEqual`; anything else closes the socket.
4. Static files are served without the token (they contain no data).

## Transcript vs. context

`loadSession` returns the *model's* history: after a compaction it starts from
the summary. A UI should show the *user's* history — everything that was said,
with a divider where compaction happened. Core needs a sibling:

```ts
// core/src/agent/session.ts
export async function loadTranscript(agentDir: string, id: string): Promise<TranscriptItem[]>;
type TranscriptItem =
  | { type: 'message'; ts: number; message: Message }
  | { type: 'compaction'; ts: number; tokensBefore: number; tokensAfter: number };
```

It replays every `message` event and turns `compaction` events into markers.
`SessionSnapshot.transcript` becomes `TranscriptItem[]`.

## Core changes required

Small and additive; none touch the loop.

1. `loadTranscript` (above).
2. `readSessionSummary(agentDir, id)` — title from the first user message; cheap
   enough to read the file head.
3. Extract the config assembly in `cli/src/index.ts` (`loadSettings` →
   `ProviderRegistry.resolve` → `resolveBudgets` → `AgentSessionConfig`) into a
   core helper, so the server and CLI build sessions identically.
4. Move `EventBuffer` + the reducer's fold logic out of `packages/tui` into a
   shared, dependency-free module so TUI and web fold events the same way
   (they are already Ink-free).

## Packages

```
packages/protocol   types + zod schemas for frames/params; no node deps (web imports it)
packages/server     SessionHost, WS RPC, static serving, auth — deps: core, protocol, ws
packages/web        React 19 + Vite + Tailwind 4 — deps: protocol
packages/cli        + `hc web [--port]`: start server, open browser
packages/desktop    later: Electron main embeds server, loads web
```

## Out of scope for v1

File tree / `@file` mentions (`fs.list`), git diff panel, settings editor,
multi-workspace, run queueing, remote access. Each is new methods on the same
socket; none change the frame format.
