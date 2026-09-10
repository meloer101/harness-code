/**
 * Signature-level tool-loop guardrails.
 *
 * Catches three stall patterns the step-back nudge misses: the same call
 * failing repeatedly, the same tool failing across tweaked args, and a
 * read-only tool returning the same result over and over. Pure logic —
 * decisions only; the loop turns `deny` into an error tool_result and
 * `appendToResult` into a warning appended onto that result.
 */

import { createHash } from 'node:crypto';

import { stableStringify } from '../util/json.js';
import type { ToolUseBlock } from '../provider/types.js';
import type { ToolResult } from '../tools/types.js';
import type { AgentHooks, PermissionDecision, ToolCallFeedback, TurnContext } from './hooks.js';

export interface ToolGuardrailThresholds {
  /** Warn after this many identical failing calls (1-based count after the call). */
  sameCallFailWarn: number;
  /** Block after this many identical failing calls. */
  sameCallFailBlock: number;
  /** Warn after this many failures of the same tool (any args). */
  sameToolFailWarn: number;
  /** Block after this many failures of the same tool (any args). */
  sameToolFailBlock: number;
  /** Warn after this many identical read-only results for the same call. */
  sameReadWarn: number;
  /** Block after this many identical read-only results for the same call. */
  sameReadBlock: number;
}

export const DEFAULT_GUARDRAIL_THRESHOLDS: ToolGuardrailThresholds = {
  sameCallFailWarn: 2,
  sameCallFailBlock: 5,
  sameToolFailWarn: 3,
  sameToolFailBlock: 8,
  sameReadWarn: 2,
  sameReadBlock: 5,
};

export interface ToolGuardrailOptions {
  /** Lookup whether a tool is read-only. Defaults to `false` (treat as write). */
  isReadOnly?(name: string): boolean;
  thresholds?: Partial<ToolGuardrailThresholds>;
}

const RECOVERY =
  'Diagnose before retrying the same call; change arguments or switch tools; ' +
  'if blocked by something external, report it and stop rather than looping.';

function callSignature(call: ToolUseBlock): string {
  return `${call.name}\0${stableStringify(call.input ?? {})}`;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function warning(kind: string, detail: string): string {
  return `[Tool loop warning: ${kind}] ${detail} ${RECOVERY}`;
}

/**
 * Builds an `AgentHooks` set that tracks tool-call signatures across a run.
 * Wire it via `mergeHooks` after the permission hooks so a permission deny
 * still wins, and before compaction (order among non-permission hooks is
 * irrelevant for these two methods).
 */
export function createToolGuardrailHooks(opts: ToolGuardrailOptions = {}): AgentHooks {
  const thresholds: ToolGuardrailThresholds = {
    ...DEFAULT_GUARDRAIL_THRESHOLDS,
    ...opts.thresholds,
  };
  const isReadOnly = opts.isReadOnly ?? (() => false);

  const sameCallFails = new Map<string, number>();
  const sameToolFails = new Map<string, number>();
  const sameReads = new Map<string, number>();
  /** Call ids we already blocked in `onBeforeToolCall` — skip recounting in after. */
  const blockedIds = new Set<string>();

  function resetAll(): void {
    sameCallFails.clear();
    sameToolFails.clear();
    sameReads.clear();
  }

  return {
    onBeforeToolCall(call: ToolUseBlock, _ctx: TurnContext): PermissionDecision {
      const sig = callSignature(call);
      const callFails = sameCallFails.get(sig) ?? 0;
      // Block the Nth attempt once N-1 failures are already recorded.
      if (callFails + 1 >= thresholds.sameCallFailBlock) {
        blockedIds.add(call.id);
        return {
          decision: 'deny',
          reason:
            `Tool loop blocked: "${call.name}" with the same arguments has failed ` +
            `${callFails} times. Stop and report rather than retrying.`,
        };
      }
      const toolFails = sameToolFails.get(call.name) ?? 0;
      if (toolFails + 1 >= thresholds.sameToolFailBlock) {
        blockedIds.add(call.id);
        return {
          decision: 'deny',
          reason:
            `Tool loop blocked: "${call.name}" has failed ${toolFails} times across ` +
            `different arguments. Stop and report rather than retrying.`,
        };
      }
      // same-read: block the next call once any identical prior result hit the threshold.
      for (const [key, count] of sameReads) {
        if (key.startsWith(`${sig}\0`) && count + 1 >= thresholds.sameReadBlock) {
          blockedIds.add(call.id);
          return {
            decision: 'deny',
            reason:
              `Tool loop blocked: read-only "${call.name}" returned the same result ` +
              `${count} times. Stop re-reading and use what you already have.`,
          };
        }
      }
      return { decision: 'allow' };
    },

    onAfterToolCall(
      call: ToolUseBlock,
      result: ToolResult,
      _ctx: TurnContext,
    ): ToolCallFeedback | void {
      if (blockedIds.has(call.id)) {
        blockedIds.delete(call.id);
        return undefined;
      }

      const failed = result.isError === true;
      const readOnly = isReadOnly(call.name);
      const sig = callSignature(call);
      const warnings: string[] = [];

      if (!failed && !readOnly) {
        resetAll();
        return undefined;
      }

      if (failed) {
        const callCount = (sameCallFails.get(sig) ?? 0) + 1;
        sameCallFails.set(sig, callCount);
        const toolCount = (sameToolFails.get(call.name) ?? 0) + 1;
        sameToolFails.set(call.name, toolCount);

        if (callCount === thresholds.sameCallFailWarn) {
          warnings.push(
            warning(
              'repeated failing call',
              `"${call.name}" with the same arguments has failed ${callCount} times.`,
            ),
          );
        }
        if (
          toolCount === thresholds.sameToolFailWarn &&
          // Avoid duplicating the same-call warning when args haven't changed.
          callCount !== thresholds.sameCallFailWarn
        ) {
          warnings.push(
            warning(
              'repeated tool failures',
              `"${call.name}" has failed ${toolCount} times (arguments may differ).`,
            ),
          );
        }
      } else if (readOnly) {
        const key = `${sig}\0${contentHash(result.content)}`;
        const count = (sameReads.get(key) ?? 0) + 1;
        sameReads.set(key, count);
        if (count === thresholds.sameReadWarn) {
          warnings.push(
            warning(
              'unchanging read',
              `read-only "${call.name}" returned the same result ${count} times.`,
            ),
          );
        }
      }

      return warnings.length > 0 ? { appendToResult: warnings.join('\n\n') } : undefined;
    },
  };
}
