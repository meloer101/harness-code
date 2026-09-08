/**
 * Pure number/string formatting shared by the engine's notices, the CLI's
 * text renderer and the TUI's meter bars.
 *
 * Deliberately dependency-free and colour-free: this is about *what* a number
 * says, not how it is painted. Colours and line layout are the sink's job.
 */

import type { ContextBreakdown } from '../context/budget.js';

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

/** `sys 2.1k · mem 0.4k · tools 3.0k · hist 6.2k` — the parts of the window. */
export function fmtBreakdown(b: ContextBreakdown): string {
  return (
    `sys ${fmtTokens(b.system)}` +
    (b.skills > 0 ? ` · skl ${fmtTokens(b.skills)}` : '') +
    (b.projectMemory > 0 ? ` · mem ${fmtTokens(b.projectMemory)}` : '') +
    ` · tools ${fmtTokens(b.toolSchemas)} · hist ${fmtTokens(b.history)}`
  );
}
