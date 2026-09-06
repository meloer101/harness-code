/**
 * Budget resolution: `flag ?? settings ?? (loop default)`.
 *
 * Split out so it is unit-testable — before this existed, `hc agent` forwarded
 * only the CLI flags and a `maxTurns` set in settings.json was silently ignored,
 * every run falling through to the loop's built-in default of 50.
 */

import type { Settings } from '@harness-code/core';

export interface BudgetFlags {
  maxTurns?: number;
  maxCost?: number;
  maxTokens?: number;
}

export interface ResolvedBudgets {
  maxTurns?: number;
  maxCostUSD?: number;
  maxTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
}

/**
 * A field left `undefined` here is passed to `AgentLoop` as absent, so the loop
 * applies its own default — this function never invents one.
 */
export function resolveBudgets(flags: BudgetFlags, settings: Settings): ResolvedBudgets {
  return {
    maxTurns: flags.maxTurns ?? settings.maxTurns,
    maxCostUSD: flags.maxCost ?? settings.maxCostUSD,
    maxTokens: flags.maxTokens ?? settings.maxTokens,
    maxOutputTokens: settings.maxOutputTokens,
    temperature: settings.temperature,
  };
}
