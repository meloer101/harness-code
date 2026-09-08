/**
 * Renderers for `hc trace` (one session's timeline) and `hc stats` (totals
 * across every recorded session). Both return a finished string so they can be
 * unit-tested without capturing stdout; the commands just `console.log` it.
 */

import type { StatsRollup, TraceEvent } from '@harness-code/core';
import { fmtDuration, fmtRelTime, fmtTokens, fmtUSD } from './format.js';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const RED = '\x1b[31m';

function usageBits(e: {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}): string {
  const cachePct =
    e.inputTokens > 0 ? Math.round((e.cachedInputTokens / e.inputTokens) * 100) : 0;
  return (
    `in ${fmtTokens(e.inputTokens)} · out ${fmtTokens(e.outputTokens)}` +
    (e.cachedInputTokens > 0 ? ` · cached ${fmtTokens(e.cachedInputTokens)} (${cachePct}%)` : '')
  );
}

/** `+4.2s   model   in 4.2k · out 120 · $0.00051 · ttft 640ms · 2.1s · tool_use` */
export function renderTimeline(id: string, events: TraceEvent[]): string {
  if (events.length === 0) return `trace ${id} is empty`;

  const origin = events[0]?.ts ?? 0;
  const lines: string[] = [];
  let runs = 0;

  const at = (ts: number): string => fmtRelTime(ts - origin).padEnd(8);

  for (const ev of events) {
    switch (ev.type) {
      case 'run_start': {
        runs++;
        lines.push('');
        lines.push(
          `${DIM}run ${runs}  ·  ${ev.model}  ·  ${ev.mode ?? '?'} mode` +
            (ev.resumed ? '  ·  resumed' : '') +
            RESET,
        );
        break;
      }
      case 'model_call': {
        const bits = [usageBits(ev)];
        if (ev.costUSD !== undefined) bits.push(fmtUSD(ev.costUSD));
        if (ev.ttftMs !== undefined) bits.push(`ttft ${ev.ttftMs}ms`);
        if (ev.latencyMs !== undefined) bits.push(fmtDuration(ev.latencyMs));
        bits.push(ev.stopReason);
        if (ev.estimated) bits.push('~est');
        lines.push(`  ${at(ev.ts)}model   ${bits.join(' · ')}`);
        break;
      }
      case 'tool_call': {
        const flag = ev.denied
          ? `${RED}denied${RESET} `
          : ev.isError
            ? `${RED}error${RESET} `
            : '';
        lines.push(
          `  ${at(ev.ts)}tool    ${ev.name} ${ev.inputSummary}  ` +
            `${DIM}${fmtDuration(ev.durationMs)} · ${fmtBytes(ev.outputBytes)}${RESET} ${flag}`.trimEnd(),
        );
        break;
      }
      case 'subagent': {
        lines.push(
          `  ${at(ev.ts)}subagent ${ev.name}  ${DIM}${ev.turns} turn(s) · ` +
            `${usageBits(ev)} · ${ev.stopReason}${RESET}`,
        );
        break;
      }
      case 'compaction': {
        lines.push(
          `  ${at(ev.ts)}${DIM}compact ${fmtTokens(ev.tokensBefore)} → ${fmtTokens(ev.tokensAfter)} ` +
            `(kept ${ev.keptTurns} turn(s))${RESET}`,
        );
        break;
      }
      case 'context': {
        // One per turn on disk; only worth showing once the window is filling up.
        if (ev.ratio >= 0.75) {
          lines.push(
            `  ${at(ev.ts)}${DIM}context ${fmtTokens(ev.usedTokens)}/${fmtTokens(ev.windowTokens)} ` +
              `(${Math.round(ev.ratio * 100)}%)${RESET}`,
          );
        }
        break;
      }
      case 'error': {
        lines.push(`  ${at(ev.ts)}${RED}error   ${ev.scope}: ${ev.message}${RESET}`);
        break;
      }
      case 'run_end': {
        const bits = [usageBits(ev)];
        if (ev.costUSD !== undefined) bits.push(fmtUSD(ev.costUSD));
        bits.push(`wall ${fmtDuration(ev.wallMs)}`);
        lines.push(
          `  ${at(ev.ts)}${DIM}end     ${ev.stopReason} · ${ev.turns} turn(s) · ${bits.join(' · ')}${RESET}`,
        );
        break;
      }
      default:
        break;
    }
  }

  const header =
    `trace ${id}  ·  ${runs} run(s)` +
    (events.length > 1
      ? `  ·  span ${fmtDuration((events[events.length - 1]?.ts ?? origin) - origin)}`
      : '');
  return [header, ...lines].join('\n');
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The `hc stats` table. */
export function renderStats(r: StatsRollup): string {
  if (r.sessions === 0) return 'no recorded sessions under .agent/traces';

  const span =
    r.span.from > 0
      ? `${isoDay(r.span.from)} → ${isoDay(r.span.to)}`
      : '(no dated sessions)';
  const lines: string[] = [
    `stats  ·  ${r.sessions} session(s)  ·  ${span}`,
    '',
    row('turns', `${r.totalTurns}`, `${r.avgTurnsPerSession.toFixed(1)} avg/session`),
    row('tool calls', `${r.totalToolCalls}`),
    row(
      'input tokens',
      fmtTokens(r.totalInputTokens),
      `cache ${Math.round(r.overallCacheHitRate * 100)}%`,
    ),
    row('output tokens', fmtTokens(r.totalOutputTokens)),
    row(
      'cost',
      fmtUSD(r.totalCostUSD),
      `${fmtUSD(r.avgCostPerSession)} avg/session` +
        (r.sessionsWithPartialCost > 0
          ? ` — ${r.sessionsWithPartialCost} session(s) had unpriced model calls`
          : ''),
    ),
  ];
  if (r.totalSubagentRuns > 0) lines.push(row('sub-agent runs', `${r.totalSubagentRuns}`));
  if (r.totalCompactions > 0) lines.push(row('compactions', `${r.totalCompactions}`));

  if (r.byModel.length > 0) {
    lines.push('', 'by model');
    for (const m of r.byModel) {
      lines.push(
        `  ${m.model}` +
          `  ${DIM}${m.sessions} session(s) · ${m.turns} turn(s) · ` +
          `in ${fmtTokens(m.inputTokens)} · out ${fmtTokens(m.outputTokens)} · ` +
          `${fmtUSD(m.costUSD)}${m.costPartial ? '+' : ''}${RESET}`,
      );
    }
  }
  return lines.join('\n');
}

function row(label: string, value: string, note?: string): string {
  const base = `${label.padEnd(16)}${value}`;
  return note ? `${base}${DIM}   (${note})${RESET}` : base;
}

function isoDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
