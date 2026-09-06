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
}

export type PermissionDecision = { decision: 'allow' } | { decision: 'deny'; reason: string };

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
  /** Stub for now — Phase 4's compactor decides here whether to summarize. */
  onContextPressure?(ctx: TurnContext): Promise<void> | void;
}

export const allowAllHooks: AgentHooks = {
  onBeforeToolCall: () => ({ decision: 'allow' }),
};
