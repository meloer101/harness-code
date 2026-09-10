/**
 * The event stream carried by `{ t: 'evt' }` server frames. Verbatim from
 * docs/web.md, "Events". `AgentEvent`, `Notice`, `AgentStopReason`, `Usage`,
 * and `PermissionMode` are `import type`-only from core — never redefined
 * here, so they can't drift from the loop's actual event shapes.
 */

import type { AgentEvent, AgentStopReason, Notice, PermissionMode, Usage } from '@harness-code/core';

export type WireEvent =
  // AgentEvent, forwarded verbatim (deltas coalesced by EventBuffer)
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
