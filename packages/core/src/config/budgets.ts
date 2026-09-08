/**
 * Budget resolution: `flag ?? settings ?? (loop default)`.
 *
 * Lives in core (not the CLI) so the session engine, the CLI and the eval
 * harness all resolve the same numbers through the same function. A field left
 * `undefined` is passed to `AgentLoop` as absent, so the loop applies its own
 * default — this function never invents one.
 */

import type { Settings } from './settings.js';

export interface BudgetFlags {
  maxTurns?: number;
  maxCost?: number;
  maxTokens?: number;
  /** `--no-compact`: disable automatic context compaction for this run. */
  noCompact?: boolean;
}

export interface ResolvedBudgets {
  maxTurns?: number;
  maxCostUSD?: number;
  maxTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
  contextCompactRatio?: number;
  compactKeepTurns?: number;
  subagentMaxTurns?: number;
}

export function resolveBudgets(flags: BudgetFlags, settings: Settings): ResolvedBudgets {
  return {
    maxTurns: flags.maxTurns ?? settings.maxTurns,
    maxCostUSD: flags.maxCost ?? settings.maxCostUSD,
    maxTokens: flags.maxTokens ?? settings.maxTokens,
    maxOutputTokens: settings.maxOutputTokens,
    temperature: settings.temperature,
    // `--no-compact` wins by pushing the trigger past any reachable ratio.
    contextCompactRatio: flags.noCompact ? Number.POSITIVE_INFINITY : settings.contextCompactRatio,
    compactKeepTurns: settings.compactKeepTurns,
    subagentMaxTurns: settings.subagentMaxTurns,
  };
}
