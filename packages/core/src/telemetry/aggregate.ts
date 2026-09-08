/**
 * Trace aggregation — pure, no I/O.
 *
 * `summarizeTrace` folds one session's event stream into a row; `rollupStats`
 * folds many rows into the cross-session totals `hc stats` prints. Kept free of
 * the filesystem so both are trivially testable and the CLI owns the reading.
 *
 * Cost is only known for models with a pricing rule (`provider/capabilities.ts`);
 * everything else contributes tokens but not dollars, and the summary tracks how
 * many sessions that was so the total is never silently understated.
 */

import { cacheHitRate } from '../context/cache.js';
import type { TraceEvent } from './trace.js';

export interface TraceSummary {
  id: string;
  /** ts of the first event (run_start, normally). */
  startedAt: number;
  /** The model ref this session mostly ran on. */
  model: string;
  /** Model calls across every run in the session. */
  turns: number;
  toolCalls: number;
  /** Tool calls the permission engine refused. */
  deniedToolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Summed known cost; 0 when no priced model call was seen. */
  costUSD: number;
  /** True when at least one model call had no price (cost is a floor). */
  costPartial: boolean;
  /** True when any token count was the harness's estimate. */
  tokensEstimated: boolean;
  cacheHitRate: number;
  /** Summed wall time of the runs that reported it. */
  wallMs: number;
  /** stopReason of the last run_end / model_call seen. */
  stopReason?: string;
  subagentRuns: number;
  compactions: number;
}

export function summarizeTrace(id: string, events: TraceEvent[]): TraceSummary {
  const s: TraceSummary = {
    id,
    startedAt: events[0]?.ts ?? 0,
    model: '',
    turns: 0,
    toolCalls: 0,
    deniedToolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUSD: 0,
    costPartial: false,
    tokensEstimated: false,
    cacheHitRate: 0,
    wallMs: 0,
    subagentRuns: 0,
    compactions: 0,
  };

  const modelCounts = new Map<string, number>();

  for (const ev of events) {
    switch (ev.type) {
      case 'run_start':
        if (!s.model) s.model = ev.model;
        break;
      case 'model_call': {
        s.turns++;
        s.inputTokens += ev.inputTokens;
        s.outputTokens += ev.outputTokens;
        s.cachedInputTokens += ev.cachedInputTokens;
        if (ev.costUSD !== undefined) s.costUSD += ev.costUSD;
        else s.costPartial = true;
        if (ev.estimated) s.tokensEstimated = true;
        s.stopReason = ev.stopReason;
        modelCounts.set(ev.model, (modelCounts.get(ev.model) ?? 0) + 1);
        break;
      }
      case 'tool_call':
        s.toolCalls++;
        if (ev.denied) s.deniedToolCalls++;
        break;
      case 'compaction':
        s.compactions++;
        if (ev.costUSD !== undefined) s.costUSD += ev.costUSD;
        break;
      case 'subagent': {
        s.subagentRuns++;
        s.inputTokens += ev.inputTokens;
        s.outputTokens += ev.outputTokens;
        s.cachedInputTokens += ev.cachedInputTokens;
        if (ev.costUSD !== undefined) s.costUSD += ev.costUSD;
        else s.costPartial = true;
        break;
      }
      case 'run_end':
        s.wallMs += ev.wallMs;
        s.stopReason = ev.stopReason;
        break;
      default:
        break;
    }
  }

  // Prefer the most-used model_call model; fall back to run_start's ref.
  let best = s.model;
  let bestN = 0;
  for (const [m, n] of modelCounts) {
    if (n > bestN) {
      best = m;
      bestN = n;
    }
  }
  s.model = best || s.model || '(unknown)';
  s.cacheHitRate = cacheHitRate({
    inputTokens: s.inputTokens,
    cachedInputTokens: s.cachedInputTokens,
  });
  return s;
}

export interface ModelRollup {
  model: string;
  sessions: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUSD: number;
  costPartial: boolean;
}

export interface StatsRollup {
  sessions: number;
  totalTurns: number;
  totalToolCalls: number;
  totalDeniedToolCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalCostUSD: number;
  /** Sessions where at least one model call had no price. */
  sessionsWithPartialCost: number;
  totalSubagentRuns: number;
  totalCompactions: number;
  avgTurnsPerSession: number;
  avgCostPerSession: number;
  overallCacheHitRate: number;
  byModel: ModelRollup[];
  /** ts span [earliest start, latest start]; both 0 when there are no sessions. */
  span: { from: number; to: number };
}

export function rollupStats(summaries: TraceSummary[]): StatsRollup {
  const r: StatsRollup = {
    sessions: summaries.length,
    totalTurns: 0,
    totalToolCalls: 0,
    totalDeniedToolCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedInputTokens: 0,
    totalCostUSD: 0,
    sessionsWithPartialCost: 0,
    totalSubagentRuns: 0,
    totalCompactions: 0,
    avgTurnsPerSession: 0,
    avgCostPerSession: 0,
    overallCacheHitRate: 0,
    byModel: [],
    span: { from: 0, to: 0 },
  };

  const byModel = new Map<string, ModelRollup>();

  for (const s of summaries) {
    r.totalTurns += s.turns;
    r.totalToolCalls += s.toolCalls;
    r.totalDeniedToolCalls += s.deniedToolCalls;
    r.totalInputTokens += s.inputTokens;
    r.totalOutputTokens += s.outputTokens;
    r.totalCachedInputTokens += s.cachedInputTokens;
    r.totalCostUSD += s.costUSD;
    if (s.costPartial) r.sessionsWithPartialCost++;
    r.totalSubagentRuns += s.subagentRuns;
    r.totalCompactions += s.compactions;

    if (s.startedAt > 0) {
      r.span.from = r.span.from === 0 ? s.startedAt : Math.min(r.span.from, s.startedAt);
      r.span.to = Math.max(r.span.to, s.startedAt);
    }

    let m = byModel.get(s.model);
    if (!m) {
      m = {
        model: s.model,
        sessions: 0,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUSD: 0,
        costPartial: false,
      };
      byModel.set(s.model, m);
    }
    m.sessions++;
    m.turns += s.turns;
    m.inputTokens += s.inputTokens;
    m.outputTokens += s.outputTokens;
    m.cachedInputTokens += s.cachedInputTokens;
    m.costUSD += s.costUSD;
    if (s.costPartial) m.costPartial = true;
  }

  if (r.sessions > 0) {
    r.avgTurnsPerSession = r.totalTurns / r.sessions;
    r.avgCostPerSession = r.totalCostUSD / r.sessions;
  }
  r.overallCacheHitRate = cacheHitRate({
    inputTokens: r.totalInputTokens,
    cachedInputTokens: r.totalCachedInputTokens,
  });
  r.byModel = [...byModel.values()].sort((a, b) => b.turns - a.turns);
  return r;
}
