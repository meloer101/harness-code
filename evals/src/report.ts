/**
 * Turn `TaskResult[]` into a committed baseline, a scannable table, and a
 * pass/fail regression verdict against the last baseline.
 */

import type { TaskResult } from './runner.js';

export interface Baseline {
  generatedAt: string;
  model: string;
  tasks: Record<
    string,
    { passRate: number; passK: boolean; avgTurns: number; avgTokens: number; avgCostUSD: number }
  >;
}

export interface Report {
  generatedAt: string;
  model: string;
  results: TaskResult[];
  totals: {
    tasks: number;
    passK: number;
    pass1: number;
    avgTurns: number;
    avgTokens: number;
    avgCostUSD: number;
    refusalTasks: number;
    refusalCorrect: number;
  };
}

export function buildReport(results: TaskResult[], model: string): Report {
  const refusal = results.filter((r) => r.expectRefusal);
  const num = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    generatedAt: new Date().toISOString(),
    model,
    results,
    totals: {
      tasks: results.length,
      passK: results.filter((r) => r.passK).length,
      pass1: results.filter((r) => r.pass1).length,
      avgTurns: num(results.map((r) => r.avgTurns)),
      avgTokens: num(results.map((r) => r.avgTokens)),
      avgCostUSD: num(results.map((r) => r.avgCostUSD)),
      refusalTasks: refusal.length,
      refusalCorrect: refusal.filter((r) => r.passK).length,
    },
  };
}

export function toBaseline(report: Report): Baseline {
  const tasks: Baseline['tasks'] = {};
  for (const r of report.results) {
    tasks[r.id] = {
      passRate: round(r.passRate, 3),
      passK: r.passK,
      avgTurns: round(r.avgTurns, 2),
      avgTokens: Math.round(r.avgTokens),
      avgCostUSD: round(r.avgCostUSD, 6),
    };
  }
  return { generatedAt: report.generatedAt, model: report.model, tasks };
}

export interface Regression {
  task: string;
  kind: 'pass' | 'tokens' | 'cost';
  detail: string;
}

const COST_TOKEN_TOLERANCE = 0.15;

/** A drop in pass@k, or tokens/cost up more than 15%, is a regression. */
export function diffBaseline(report: Report, baseline: Baseline | undefined): Regression[] {
  if (!baseline) return [];
  const out: Regression[] = [];
  for (const r of report.results) {
    const base = baseline.tasks[r.id];
    if (!base) continue;
    if (base.passK && !r.passK) {
      out.push({ task: r.id, kind: 'pass', detail: `pass@k ${pct(base.passRate)} → 0%` });
    } else if (r.passRate < base.passRate - 1e-9) {
      out.push({
        task: r.id,
        kind: 'pass',
        detail: `pass rate ${pct(base.passRate)} → ${pct(r.passRate)}`,
      });
    }
    if (base.avgTokens > 0 && r.avgTokens > base.avgTokens * (1 + COST_TOKEN_TOLERANCE)) {
      out.push({
        task: r.id,
        kind: 'tokens',
        detail: `avg tokens ${fmt(base.avgTokens)} → ${fmt(r.avgTokens)} (+${pct(r.avgTokens / base.avgTokens - 1)})`,
      });
    }
    if (base.avgCostUSD > 0 && r.avgCostUSD > base.avgCostUSD * (1 + COST_TOKEN_TOLERANCE)) {
      out.push({
        task: r.id,
        kind: 'cost',
        detail: `avg cost $${base.avgCostUSD.toFixed(5)} → $${r.avgCostUSD.toFixed(5)}`,
      });
    }
  }
  return out;
}

export function renderTable(report: Report): string {
  const rows = report.results.map((r) => {
    const cost = r.costPartial ? '—' : `$${r.avgCostUSD.toFixed(5)}`;
    return `| ${r.id} | ${r.tags.join(', ') || '—'} | ${pct(r.passRate)} (${passFrac(r)}) | ${r.avgTurns.toFixed(1)} | ${fmt(r.avgTokens)} | ${cost} |`;
  });
  const t = report.totals;
  return [
    `**${report.model}** · ${new Date(report.generatedAt).toISOString().slice(0, 10)} · ${t.passK}/${t.tasks} tasks pass@k, ${t.pass1}/${t.tasks} pass@1`,
    '',
    '| task | tags | pass@k | avg turns | avg tokens | avg cost |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `refusal correctness: ${t.refusalCorrect}/${t.refusalTasks}`,
  ].join('\n');
}

/**
 * Two arms of an ablation, side by side. `arms` names the columns; it defaults
 * to `on`/`off` (as the compaction ablation reads), but a dimension without a
 * natural on/off — e.g. prompt-encoded vs native tool calling — can pass its own
 * labels so the table is not misleading.
 */
export function renderComparison(
  label: string,
  on: Report,
  off: Report,
  arms: { on: string; off: string } = { on: 'on', off: 'off' },
): string {
  const ids = on.results.map((r) => r.id);
  const rows = ids.map((id) => {
    const a = on.results.find((r) => r.id === id);
    const b = off.results.find((r) => r.id === id);
    if (!a || !b) return `| ${id} | ? | ? |`;
    return `| ${id} | ${pct(a.passRate)} · ${fmt(a.avgTokens)}t · ${a.avgTurns.toFixed(1)} | ${pct(b.passRate)} · ${fmt(b.avgTokens)}t · ${b.avgTurns.toFixed(1)} |`;
  });
  return [
    `### Ablation: ${label}`,
    '',
    `| task | ${label}: ${arms.on} (pass · tokens · turns) | ${arms.off} |`,
    '| --- | --- | --- |',
    ...rows,
    '',
    `totals — ${arms.on}: ${fmt(on.totals.avgTokens)} avg tokens, ${on.totals.passK}/${on.totals.tasks} pass@k · ` +
      `${arms.off}: ${fmt(off.totals.avgTokens)} avg tokens, ${off.totals.passK}/${off.totals.tasks} pass@k`,
  ].join('\n');
}

function passFrac(r: TaskResult): string {
  return `${r.runs.filter((x) => x.passed).length}/${r.n}`;
}
function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}
function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
