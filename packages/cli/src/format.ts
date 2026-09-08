/**
 * Terminal formatting helpers shared by the `agent` REPL and the `trace` /
 * `stats` telemetry commands.
 *
 * The pure number formatters (`fmtTokens` / `fmtUSD` / `fmtDuration` /
 * `fmtBreakdown`) and `ContextSnapshot` live in core now (the session engine's
 * notices and the TUI meter need them too); this file re-exports them and adds
 * the CLI-only rendering (`printUsage`, `cacheSummary`, `describeStop`).
 * Plain ANSI, no table/colour deps — the same dim/yellow/red vocabulary `hc`
 * uses everywhere.
 */

import {
  cacheHitRate,
  fmtBreakdown,
  fmtDuration,
  fmtTokens,
  fmtUSD,
} from '@harness-code/core';
import type { ContextBreakdown } from '@harness-code/core';

export { fmtTokens, fmtUSD, fmtDuration, fmtBreakdown } from '@harness-code/core';
export type { ContextSnapshot } from '@harness-code/core';

/** `+0.0s` / `+4.2s` / `+1m03s` — offset from a timeline's start. */
export function fmtRelTime(ms: number): string {
  return `+${fmtDuration(ms)}`;
}

export function printUsage(
  ref: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    costUSD?: number;
    estimated?: boolean;
  },
  latencyMs?: number,
  ttftMs?: number,
  context?: {
    usedTokens: number;
    windowTokens: number;
    ratio: number;
    breakdown?: ContextBreakdown;
  },
): void {
  const bits = [ref, `in ${usage.inputTokens}`, `out ${usage.outputTokens}`];
  if (usage.cachedInputTokens > 0) {
    bits.push(`cached ${usage.cachedInputTokens} (${Math.round(cacheHitRate(usage) * 100)}%)`);
  }
  if (usage.costUSD !== undefined) bits.push(fmtUSD(usage.costUSD));
  if (context) {
    bits.push(
      `ctx ${fmtTokens(context.usedTokens)}/${fmtTokens(context.windowTokens)} ` +
        `(${Math.round(context.ratio * 100)}%)`,
    );
    if (context.breakdown) bits.push(fmtBreakdown(context.breakdown));
  }
  if (ttftMs !== undefined) bits.push(`ttft ${ttftMs}ms`);
  if (latencyMs !== undefined) bits.push(`total ${latencyMs}ms`);
  if (usage.estimated) bits.push('(token counts estimated)');
  process.stderr.write(`\x1b[2m${bits.join('  ·  ')}\x1b[0m\n`);
}

/** End-of-session prompt-cache line, or '' when nothing was cached. */
export function cacheSummary(
  usage: { inputTokens: number; cachedInputTokens: number } | undefined,
): string {
  if (!usage || usage.inputTokens === 0 || usage.cachedInputTokens === 0) return '';
  return ` · cache ${Math.round(cacheHitRate(usage) * 100)}% of ${fmtTokens(usage.inputTokens)} input tokens`;
}

/** A one-liner explaining why the loop stopped, for the reasons a user should act on. */
export function describeStop(reason: string): string | undefined {
  switch (reason) {
    case 'context_limit':
      return 'stopped: context window nearly full. Start a new session to continue.';
    case 'max_tokens':
      return 'stopped: hit the --max-tokens budget (limit triggered after the turn that crossed it, not a hard ceiling).';
    case 'max_cost':
      return 'stopped: hit the --max-cost budget (limit triggered after the turn that crossed it, not a hard ceiling).';
    case 'max_turns':
      return 'stopped: hit the max-turns budget.';
    case 'stopped_by_tool':
      return 'stopped: plan written for review under .agent/plans/ (no interactive approver).';
    default:
      return undefined;
  }
}
