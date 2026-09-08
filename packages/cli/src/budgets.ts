/**
 * Budget resolution — re-exported from core so the CLI, the session engine and
 * the eval harness resolve the same numbers through the same function.
 *
 * (Kept as a file so existing `./budgets.js` imports don't change; the real
 * implementation is `packages/core/src/config/budgets.ts`.)
 */

export { resolveBudgets } from '@harness-code/core';
export type { BudgetFlags, ResolvedBudgets } from '@harness-code/core';
