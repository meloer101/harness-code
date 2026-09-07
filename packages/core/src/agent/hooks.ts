/**
 * The loop's only extension point.
 *
 * Everything downstream — Phase 3's permission engine, Phase 4's compaction,
 * telemetry, Plan Mode — plugs in here instead of the loop growing new `if`
 * branches per feature. `allowAllHooks` is the Phase 2 default: there is no
 * real policy yet, so every tool call is allowed. Phase 3 replaces it with a
 * hook backed by the rule engine; the loop itself does not change.
 */

import type { Message, ToolUseBlock, Usage } from '../provider/types.js';
import type { ToolResult } from '../tools/types.js';

export interface TurnContext {
  turn: number;
  cwd: string;
  /** Aborts when the current turn is cancelled (Ctrl+C). Threaded through to the ask handler. */
  signal?: AbortSignal;
}

export type PermissionDecision = { decision: 'allow' } | { decision: 'deny'; reason: string };

/** What `onContextPressure` / `onCompact` are handed: how full the usable window is this turn. */
export interface ContextPressure {
  usedTokens: number;
  windowTokens: number;
  ratio: number;
}

/** What `onCompact` hands back: the history to continue with, plus what it cost. */
export interface CompactionResult {
  /** The replacement message list. Empty/omitted is treated as "no compaction". */
  messages: Message[];
  /** Usage of the summarization call itself, folded into the loop's running total. */
  usage?: Usage;
  /** How many trailing turns were kept verbatim — for the `compaction` event only. */
  keptTurns?: number;
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
  /**
   * Fired at the top of a turn once the usable window crosses
   * `contextCompactRatio` — above the warn ratio, and checked before the hard
   * `context_limit` stop so it gets first refusal at a full window. Returns the
   * history to continue with, or nothing to leave it untouched (the stop is
   * still the safety net). `context/compactor.ts` is its one implementation.
   */
  onCompact?(
    messages: readonly Message[],
    pressure: ContextPressure,
    ctx: TurnContext,
  ): Promise<CompactionResult | undefined> | CompactionResult | undefined;
}

export const allowAllHooks: AgentHooks = {
  onBeforeToolCall: () => ({ decision: 'allow' }),
};

/**
 * Compose several hook sets into one. Void hooks run in order; `onBeforeToolCall`
 * returns the first `deny` (else allow); `onCompact` returns the first result
 * that carries messages. Used by the CLI to stack the permission hooks and the
 * compactor without either knowing about the other.
 */
export function mergeHooks(...sets: (AgentHooks | undefined)[]): AgentHooks {
  const hooks = sets.filter((h): h is AgentHooks => h !== undefined);
  return {
    async onBeforeTurn(ctx) {
      for (const h of hooks) await h.onBeforeTurn?.(ctx);
    },
    async onBeforeToolCall(call, ctx) {
      for (const h of hooks) {
        const d = await h.onBeforeToolCall?.(call, ctx);
        if (d && d.decision === 'deny') return d;
      }
      return { decision: 'allow' };
    },
    async onAfterToolCall(call, result, ctx) {
      for (const h of hooks) await h.onAfterToolCall?.(call, result, ctx);
    },
    async onContextPressure(ctx, pressure) {
      for (const h of hooks) await h.onContextPressure?.(ctx, pressure);
    },
    async onCompact(messages, pressure, ctx) {
      for (const h of hooks) {
        const r = await h.onCompact?.(messages, pressure, ctx);
        if (r && r.messages.length > 0) return r;
      }
      return undefined;
    },
  };
}
