import { describe, expect, it } from 'vitest';

import { rollupStats, summarizeTrace } from './aggregate.js';
import type { TraceEvent } from './trace.js';

function modelCall(over: Partial<Extract<TraceEvent, { type: 'model_call' }>> = {}): TraceEvent {
  return {
    type: 'model_call',
    ts: 1000,
    turn: 1,
    model: 'p/m',
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 40,
    stopReason: 'tool_use',
    ...over,
  };
}

describe('summarizeTrace', () => {
  it('folds an event stream into a row', () => {
    const events: TraceEvent[] = [
      { type: 'run_start', ts: 500, sessionId: 's', model: 'p/m', cwd: '/w', mode: 'ask' },
      modelCall({ ts: 600, costUSD: 0.001 }),
      { type: 'tool_call', ts: 650, turn: 1, id: 'c1', name: 'read', inputSummary: '{}', durationMs: 5, isError: false, outputBytes: 12 },
      modelCall({ ts: 700, turn: 2, costUSD: 0.002, stopReason: 'end_turn' }),
      { type: 'run_end', ts: 800, stopReason: 'end_turn', turns: 2, inputTokens: 200, outputTokens: 40, cachedInputTokens: 80, wallMs: 300 },
    ];

    const s = summarizeTrace('s', events);
    expect(s.turns).toBe(2);
    expect(s.toolCalls).toBe(1);
    expect(s.inputTokens).toBe(200);
    expect(s.cachedInputTokens).toBe(80);
    expect(s.costUSD).toBeCloseTo(0.003, 8);
    expect(s.costPartial).toBe(false);
    expect(s.cacheHitRate).toBeCloseTo(0.4, 8);
    expect(s.wallMs).toBe(300);
    expect(s.stopReason).toBe('end_turn');
    expect(s.model).toBe('p/m');
  });

  it('flags partial cost and folds sub-agent usage in', () => {
    const events: TraceEvent[] = [
      modelCall(), // no costUSD
      { type: 'subagent', ts: 900, turn: 0, name: 'explore', turns: 3, inputTokens: 50, outputTokens: 10, cachedInputTokens: 0, costUSD: 0.0005, stopReason: 'end_turn' },
    ];
    const s = summarizeTrace('s', events);
    expect(s.costPartial).toBe(true);
    expect(s.subagentRuns).toBe(1);
    expect(s.inputTokens).toBe(150);
    expect(s.costUSD).toBeCloseTo(0.0005, 8);
  });
});

describe('rollupStats', () => {
  it('totals, averages, and groups by model', () => {
    const a = summarizeTrace('a', [
      { type: 'run_start', ts: 1000, sessionId: 'a', model: 'p/flash', cwd: '/w' },
      modelCall({ model: 'p/flash', costUSD: 0.01 }),
      modelCall({ model: 'p/flash', costUSD: 0.01 }),
      { type: 'run_end', ts: 1100, stopReason: 'end_turn', turns: 2, inputTokens: 200, outputTokens: 40, cachedInputTokens: 80, wallMs: 100 },
    ]);
    const b = summarizeTrace('b', [
      { type: 'run_start', ts: 2000, sessionId: 'b', model: 'p/pro', cwd: '/w' },
      modelCall({ model: 'p/pro' }), // unpriced
      { type: 'run_end', ts: 2100, stopReason: 'end_turn', turns: 1, inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, wallMs: 50 },
    ]);

    const r = rollupStats([a, b]);
    expect(r.sessions).toBe(2);
    expect(r.totalTurns).toBe(3);
    expect(r.avgTurnsPerSession).toBeCloseTo(1.5, 8);
    expect(r.totalCostUSD).toBeCloseTo(0.02, 8);
    expect(r.sessionsWithPartialCost).toBe(1);
    expect(r.span).toEqual({ from: 1000, to: 2000 });
    expect(r.byModel.map((m) => m.model)).toEqual(['p/flash', 'p/pro']);
    expect(r.byModel[0]?.turns).toBe(2);
    expect(r.byModel[1]?.costPartial).toBe(true);
  });

  it('is all-zero for no sessions', () => {
    const r = rollupStats([]);
    expect(r.sessions).toBe(0);
    expect(r.avgCostPerSession).toBe(0);
    expect(r.byModel).toEqual([]);
    expect(r.span).toEqual({ from: 0, to: 0 });
  });
});
