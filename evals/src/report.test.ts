import { describe, expect, it } from 'vitest';

import { buildReport, diffBaseline, renderTable, toBaseline } from './report.js';
import type { TaskResult } from './runner.js';

function taskResult(over: Partial<TaskResult> = {}): TaskResult {
  return {
    id: 't',
    tags: ['bug-fix'],
    expectRefusal: false,
    n: 3,
    pass1: true,
    passK: true,
    passRate: 1,
    avgTurns: 5,
    avgTokens: 10_000,
    avgCostUSD: 0.003,
    costPartial: false,
    runs: [],
    ...over,
  };
}

describe('buildReport', () => {
  it('rolls up totals and refusal correctness', () => {
    const r = buildReport(
      [
        taskResult({ id: 'a' }),
        taskResult({ id: 'b', passK: false, passRate: 0, pass1: false }),
        taskResult({ id: 'refuse', expectRefusal: true, passRate: 1, passK: true }),
      ],
      'p/m',
    );
    expect(r.totals.tasks).toBe(3);
    expect(r.totals.passK).toBe(2);
    expect(r.totals.pass1).toBe(2);
    expect(r.totals.refusalTasks).toBe(1);
    expect(r.totals.refusalCorrect).toBe(1);
  });
});

describe('diffBaseline', () => {
  const report = buildReport([taskResult({ id: 'a', avgTokens: 10_000, avgCostUSD: 0.003 })], 'p/m');
  const baseline = toBaseline(report);

  it('is quiet when nothing moved', () => {
    expect(diffBaseline(report, baseline)).toEqual([]);
  });

  it('flags a pass@k drop', () => {
    const worse = buildReport([taskResult({ id: 'a', passK: false, passRate: 0 })], 'p/m');
    const regs = diffBaseline(worse, baseline);
    expect(regs).toHaveLength(1);
    expect(regs[0]).toMatchObject({ task: 'a', kind: 'pass' });
  });

  it('flags a >15% token increase but tolerates a small one', () => {
    const bumped = buildReport([taskResult({ id: 'a', avgTokens: 12_000 })], 'p/m');
    expect(diffBaseline(bumped, baseline).some((r) => r.kind === 'tokens')).toBe(true);
    const ok = buildReport([taskResult({ id: 'a', avgTokens: 10_500 })], 'p/m');
    expect(diffBaseline(ok, baseline).some((r) => r.kind === 'tokens')).toBe(false);
  });

  it('is empty with no baseline', () => {
    expect(diffBaseline(report, undefined)).toEqual([]);
  });
});

describe('renderTable', () => {
  it('produces a markdown table with a row per task', () => {
    const out = renderTable(buildReport([taskResult({ id: 'a' }), taskResult({ id: 'b' })], 'p/m'));
    expect(out).toContain('| task | tags | pass@k |');
    expect(out).toContain('| a |');
    expect(out).toContain('| b |');
    expect(out).toContain('refusal correctness:');
  });
});
