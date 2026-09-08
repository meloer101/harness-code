/**
 * Terminal formatting helpers shared by the `agent` REPL and the `trace` /
 * `stats` telemetry commands. Plain ANSI, no table/colour deps (none are on the
 * dependency list) — the same dim/yellow/red vocabulary used across `hc`.
 */

import { cacheHitRate } from '@harness-code/core';
import type { ContextBreakdown } from '@harness-code/core';

export interface ContextSnapshot {
  usedTokens: number;
  windowTokens: number;
  ratio: number;
  breakdown?: ContextBreakdown;
}

/** `12345` -> `12.3k`; small counts stay exact. */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

/** `$0.00042`, or `$0` when nothing is known. Five decimals matches `printUsage`. */
export function fmtUSD(n: number): string {
  return `$${n.toFixed(5)}`;
}

/** `820ms` / `3.2s` / `1m04s` — wall time at human resolution. */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m${String(rem).padStart(2, '0')}s`;
}

/** `+0.0s` / `+4.2s` / `+1m03s` — offset from a timeline's start. */
export function fmtRelTime(ms: number): string {
  return `+${fmtDuration(ms)}`;
}

/** `sys 2.1k · mem 0.4k · tools 3.0k · hist 6.2k` — the parts of the window. */
export function fmtBreakdown(b: ContextBreakdown): string {
  return (
    `sys ${fmtTokens(b.system)}` +
    (b.skills > 0 ? ` · skl ${fmtTokens(b.skills)}` : '') +
    (b.projectMemory > 0 ? ` · mem ${fmtTokens(b.projectMemory)}` : '') +
    ` · tools ${fmtTokens(b.toolSchemas)} · hist ${fmtTokens(b.history)}`
  );
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
  context?: ContextSnapshot,
): void {
  const bits = [ref, `in ${usage.inputTokens}`, `out ${usage.outputTokens}`];
  if (usage.cachedInputTokens > 0) {
    bits.push(`cached ${usage.cachedInputTokens} (${Math.round(cacheHitRate(usage) * 100)}%)`);
  }
  if (usage.costUSD !== undefined) bits.push(`$${usage.costUSD.toFixed(5)}`);
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
