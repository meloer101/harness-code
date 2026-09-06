/**
 * The loop's only extension point.
 *
 * Everything downstream — Phase 3's permission engine, Phase 4's compaction,
 * telemetry, Plan Mode — plugs in here instead of the loop growing new `if`
 * branches per feature. `allowAllHooks` is the Phase 2 default: there is no
 * real policy yet, so every tool call is allowed. Phase 3 replaces it with a
 * hook backed by the rule engine; the loop itself does not change.
 */

import type { ToolUseBlock } from '../provider/types.js';
import type { ToolResult } from '../tools/types.js';

export interface TurnContext {
  turn: number;
  cwd: string;
  /** Aborts when the current turn is cancelled (Ctrl+C). Threaded through to the ask handler. */
  signal?: AbortSignal;
}

export type PermissionDecision = { decision: 'allow' } | { decision: 'deny'; reason: string };

/** What `onContextPressure` is handed: how full the usable window is this turn. */
export interface ContextPressure {
  usedTokens: number;
  windowTokens: number;
  ratio: number;
}

export interface AgentHooks {
  onBeforeTurn?(ctx: TurnContext): Promise<void> | void;
  onBeforeToolCall?(
    call: ToolUseBlock,
    ctx: TurnContext,
  ): Promise<PermissionDecision> | PermissionDecision;
  onAfterToolCall?(
    call: ToolUseBlock,
    result: ToolResult,
    ctx: TurnContext,
  ): Promise<void> | void;
  /**
   * Fired at the top of a turn once the usable context window crosses
   * `contextWarnRatio`. Phase 4's compactor consumes this exact signature to
   * decide whether to summarize; for now nothing implements it.
   */
  onContextPressure?(ctx: TurnContext, pressure: ContextPressure): Promise<void> | void;
}

export const allowAllHooks: AgentHooks = {
  onBeforeToolCall: () => ({ decision: 'allow' }),
};
