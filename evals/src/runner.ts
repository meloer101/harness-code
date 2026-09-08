/**
 * Run one task: materialize its fixture into a fresh workspace, drive the agent
 * N times, run the assertion after each, and collect per-run + aggregate numbers.
 */

import { cp, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgentTask, runAssertion } from './harness.js';
import type { Task } from './tasks.js';

export interface RunConfig {
  /** Where per-run trace jsonl files land (kept for `hc trace` debugging). */
  resultsDir: string;
  /** Override the task's `runs`. */
  runs?: number;
  /** Live-record the cassette instead of replaying it. */
  record?: boolean;
  /** Hit the real endpoint directly, recording nothing (ablation measurements). */
  live?: boolean;
  /** Provider settings for record / live mode. */
  settings?: import('@harness-code/core').Settings;
  /** Keep the workspace on disk after the run. */
  keep?: boolean;
  /** Ablation knobs forwarded to the harness. */
  compaction?: boolean | number;
  contextWindow?: number;
  maxOutputTokens?: number;
  subagents?: boolean;
  promptTools?: boolean;
  /** Distinguishes trace ids / result buckets across ablation arms. */
  label?: string;
}

export interface SingleRun {
  passed: boolean;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  costPartial: boolean;
  deniedToolCalls: number;
  stopReason: string;
  /** assert.mjs / error output, only kept for failures. */
  detail?: string;
}

export interface TaskResult {
  id: string;
  tags: string[];
  expectRefusal: boolean;
  n: number;
  pass1: boolean;
  passK: boolean;
  passRate: number;
  avgTurns: number;
  avgTokens: number;
  avgCostUSD: number;
  costPartial: boolean;
  runs: SingleRun[];
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export async function runTask(task: Task, cfg: RunConfig): Promise<TaskResult> {
  const n = cfg.runs ?? task.spec.runs;
  const arm = cfg.label ? `${cfg.label}-` : '';
  const runs: SingleRun[] = [];
  // Traces land under `<resultsDir>/.agent/traces/` so `hc trace --cwd <resultsDir>` works.
  const traceDir = join(cfg.resultsDir, '.agent');
  await mkdir(traceDir, { recursive: true });

  for (let i = 0; i < n; i++) {
    const workDir = await realpath(await mkdtemp(join(tmpdir(), `hc-eval-${task.spec.id}-`)));
    try {
      await cp(task.fixtureDir, workDir, { recursive: true });

      const { result, trace } = await runAgentTask({
        workDir,
        prompt: task.spec.prompt,
        modelRef: task.spec.model,
        mode: task.spec.mode,
        traceDir,
        traceId: `${arm}${task.spec.id}-${i + 1}`,
        cassettePath: task.cassettePath,
        ...(cfg.record ? { record: true } : {}),
        ...(cfg.live ? { live: true } : {}),
        ...(cfg.settings ? { settings: cfg.settings } : {}),
        ...(cfg.compaction !== undefined ? { compaction: cfg.compaction } : {}),
        ...(cfg.contextWindow ? { contextWindow: cfg.contextWindow } : {}),
        ...(cfg.maxOutputTokens ? { maxOutputTokens: cfg.maxOutputTokens } : {}),
        ...(cfg.subagents ? { subagents: true } : {}),
        ...(cfg.promptTools ? { promptTools: true } : {}),
        ...(task.spec.allow ? { allow: task.spec.allow } : {}),
        ...(task.spec.deny ? { deny: task.spec.deny } : {}),
        ...(task.spec.maxTurns ? { maxTurns: task.spec.maxTurns } : {}),
      });

      // For every task, pass = the assertion holds in the post-run workspace.
      // A refusal task's assertion checks the forbidden outcome never landed —
      // whether the agent declined in text or the engine blocked its attempt
      // (`deniedToolCalls`, reported but not gated on) both satisfy it.
      const assertion = runAssertion(task.assertPath, workDir);
      const passed = assertion.passed;

      runs.push({
        passed,
        turns: trace.turns,
        inputTokens: trace.inputTokens,
        outputTokens: trace.outputTokens,
        costUSD: trace.costUSD,
        costPartial: trace.costPartial,
        deniedToolCalls: trace.deniedToolCalls,
        stopReason: result.stopReason,
        ...(passed ? {} : { detail: assertion.output.slice(0, 2000) || `stopReason ${result.stopReason}` }),
      });
    } finally {
      if (!cfg.keep) await rm(workDir, { recursive: true, force: true });
    }
  }

  const passes = runs.filter((r) => r.passed).length;
  return {
    id: task.spec.id,
    tags: task.spec.tags,
    expectRefusal: task.spec.expectRefusal === true,
    n,
    pass1: runs[0]?.passed === true,
    passK: passes > 0,
    passRate: passes / n,
    avgTurns: mean(runs.map((r) => r.turns)),
    avgTokens: mean(runs.map((r) => r.inputTokens + r.outputTokens)),
    avgCostUSD: mean(runs.map((r) => r.costUSD)),
    costPartial: runs.some((r) => r.costPartial),
    runs,
  };
}
