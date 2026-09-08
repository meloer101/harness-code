import { describe, expect, it } from 'vitest';

import type { StatsRollup, TraceEvent } from '@harness-code/core';
import { renderStats, renderTimeline } from './telemetry-view.js';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('renderTimeline', () => {
  it('lays out runs, model calls, tool calls and the run summary', () => {
    const events: TraceEvent[] = [
      { type: 'run_start', ts: 1_000, sessionId: 's', model: 'deepseek/deepseek-v4-flash', cwd: '/w', mode: 'ask' },
      { type: 'model_call', ts: 1_200, turn: 1, model: 'deepseek/deepseek-v4-flash', inputTokens: 4200, outputTokens: 120, cachedInputTokens: 3100, costUSD: 0.00051, ttftMs: 640, latencyMs: 2100, stopReason: 'tool_use' },
      { type: 'tool_call', ts: 1_400, turn: 1, id: 'c1', name: 'read', inputSummary: '{"path":"a.ts"}', durationMs: 18, isError: false, outputBytes: 1300 },
      { type: 'run_end', ts: 5_100, stopReason: 'end_turn', turns: 2, inputTokens: 8600, outputTokens: 200, cachedInputTokens: 6200, costUSD: 0.0011, wallMs: 4100 },
    ];

    const out = strip(renderTimeline('sess-1', events));
    expect(out).toContain('trace sess-1');
    expect(out).toContain('run 1  ·  deepseek/deepseek-v4-flash');
    expect(out).toContain('model');
    expect(out).toContain('$0.00051');
    expect(out).toContain('read {"path":"a.ts"}');
    expect(out).toContain('+200ms');
    expect(out).toContain('end     end_turn · 2 turn(s)');
  });

  it('handles an empty trace', () => {
    expect(renderTimeline('x', [])).toContain('empty');
  });
});

describe('renderStats', () => {
  const rollup: StatsRollup = {
    sessions: 3,
    totalTurns: 30,
    totalToolCalls: 64,
    totalDeniedToolCalls: 2,
    totalInputTokens: 1_200_000,
    totalOutputTokens: 84_000,
    totalCachedInputTokens: 800_000,
    totalCostUSD: 0.42,
    sessionsWithPartialCost: 1,
    totalSubagentRuns: 2,
    totalCompactions: 1,
    avgTurnsPerSession: 10,
    avgCostPerSession: 0.14,
    overallCacheHitRate: 0.6667,
    byModel: [
      { model: 'deepseek/deepseek-v4-flash', sessions: 2, turns: 24, inputTokens: 1_000_000, outputTokens: 70_000, cachedInputTokens: 700_000, costUSD: 0.31, costPartial: false },
    ],
    span: { from: Date.parse('2026-09-01'), to: Date.parse('2026-09-08') },
  };

  it('renders the table with totals and by-model', () => {
    const out = strip(renderStats(rollup));
    expect(out).toContain('3 session(s)');
    expect(out).toContain('2026-09-01 → 2026-09-08');
    expect(out).toContain('turns');
    expect(out).toContain('10.0 avg/session');
    expect(out).toContain('cache 67%');
    expect(out).toContain('1 session(s) had unpriced model calls');
    expect(out).toContain('by model');
    expect(out).toContain('deepseek/deepseek-v4-flash');
  });

  it('says so when there is nothing recorded', () => {
    const empty: StatsRollup = { ...rollup, sessions: 0, byModel: [], span: { from: 0, to: 0 } };
    expect(renderStats(empty)).toContain('no recorded sessions');
  });
});
