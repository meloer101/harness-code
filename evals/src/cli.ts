/**
 * `pnpm eval` — replay the committed cassettes against the fixture tasks, assert,
 * print the table, and gate on the baseline. Flags:
 *
 *   --task <id>          run one task (repeatable)
 *   --runs <n>           override each task's run count
 *   --record             hit the real endpoint, (re)write cassettes + baseline
 *   --model <ref>        model for --record / --ablation (default: task's own)
 *   --ablation <dim>     run the suite twice and print a comparison; <dim> is one of:
 *                          compaction    — compaction on/off (under a squeezed window)
 *                          subagents     — the `task` tool offered vs. not
 *                          prompt-tools  — prompt-encoded vs. native tool calling
 *                        Every ablation arm hits the real endpoint (a changed tool set
 *                        or window can't replay a cassette), so it needs a key in .env.
 *   --update-baseline    write the current numbers to baseline.json
 *   --keep               leave workspaces on disk
 *   --no-gate            don't exit non-zero on regression
 */

import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadSettings } from '@harness-code/core';

import { buildReport, diffBaseline, renderComparison, renderTable, toBaseline } from './report.js';
import type { Baseline } from './report.js';
import { runTask } from './runner.js';
import type { RunConfig, TaskResult } from './runner.js';
import { evalsRoot, loadTasks } from './tasks.js';

type AblationDim = 'compaction' | 'subagents' | 'prompt-tools';
const ABLATION_DIMS: readonly AblationDim[] = ['compaction', 'subagents', 'prompt-tools'];

interface Flags {
  tasks: string[];
  runs?: number;
  record: boolean;
  model?: string;
  ablation?: AblationDim;
  updateBaseline: boolean;
  keep: boolean;
  gate: boolean;
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = { tasks: [], record: false, updateBaseline: false, keep: false, gate: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--task': f.tasks.push(req(argv, ++i, a)); break;
      case '--runs': f.runs = int(req(argv, ++i, a)); break;
      case '--record': f.record = true; break;
      case '--model': f.model = req(argv, ++i, a); break;
      case '--ablation': {
        const v = req(argv, ++i, a);
        if (!(ABLATION_DIMS as readonly string[]).includes(v)) {
          fail(`--ablation supports ${ABLATION_DIMS.map((d) => `"${d}"`).join(', ')} (got "${v}")`);
        }
        f.ablation = v as AblationDim;
        break;
      }
      case '--update-baseline': f.updateBaseline = true; break;
      case '--keep': f.keep = true; break;
      case '--no-gate': f.gate = false; break;
      default: fail(`unknown flag "${a}"`);
    }
  }
  return f;
}

function req(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined) fail(`${flag} needs a value`);
  return v;
}
function int(s: string): number {
  const n = Number.parseInt(s, 10);
  if (Number.isNaN(n) || n < 1) fail(`expected a positive integer, got "${s}"`);
  return n;
}
function fail(msg: string): never {
  process.stderr.write(`eval: ${msg}\n`);
  process.exit(2);
}

const BASELINE_PATH = join(evalsRoot(), 'baseline.json');

async function readBaseline(): Promise<Baseline | undefined> {
  try {
    return JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as Baseline;
  } catch {
    return undefined;
  }
}

/** Minimal `.env` loader for `--record` — real env wins, same as the CLI's. */
function loadDotEnv(): void {
  try {
    for (const line of readFileSync(join(evalsRoot(), '..', '.env'), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || m[1] === undefined) continue;
      if (process.env[m[1]] === undefined) {
        process.env[m[1]] = (m[2] ?? '').replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // no .env — fine, the real environment may already hold the key
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.record || flags.ablation) loadDotEnv();
  const tasks = await loadTasks(flags.tasks);
  if (tasks.length === 0) fail('no tasks matched');

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsDir = join(evalsRoot(), '.results', runId);
  await mkdir(resultsDir, { recursive: true });

  const settings =
    flags.record || flags.ablation ? (await loadSettings()).settings : undefined;
  const model = flags.model ?? tasks[0]!.spec.model;

  const base: RunConfig = {
    resultsDir,
    ...(flags.runs !== undefined ? { runs: flags.runs } : {}),
    ...(flags.record ? { record: true } : {}),
    ...(settings ? { settings } : {}),
    ...(flags.keep ? { keep: true } : {}),
  };

  if (flags.ablation) {
    await runAblation(flags.ablation, tasks, base, model, resultsDir);
    return;
  }

  const results: TaskResult[] = [];
  for (const t of tasks) {
    process.stderr.write(`· ${t.spec.id} …\n`);
    const r = await runTask(t, base);
    results.push(r);
    process.stderr.write(`  ${r.passK ? 'pass' : 'FAIL'} @k, ${r.runs.filter((x) => x.passed).length}/${r.n}\n`);
  }

  const report = buildReport(results, model);
  await writeFile(join(resultsDir, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`\n${renderTable(report)}\n`);

  if (flags.record || flags.updateBaseline) {
    await writeFile(BASELINE_PATH, `${JSON.stringify(toBaseline(report), null, 2)}\n`);
    process.stderr.write(`\nbaseline written to ${BASELINE_PATH}\n`);
    return;
  }

  const regressions = diffBaseline(report, await readBaseline());
  if (regressions.length > 0) {
    process.stderr.write('\nregressions vs baseline:\n');
    for (const r of regressions) process.stderr.write(`  ${r.task}: ${r.detail}\n`);
    if (flags.gate) process.exit(1);
  } else {
    process.stderr.write('\nno regressions vs baseline\n');
  }
}

/**
 * One ablation dimension = two arms (`on`/`off`), each an independent live pass
 * of the suite. Every arm hits the real endpoint: flipping compaction, the tool
 * set, or native-vs-prompt tool calling all change the request fingerprint, so a
 * recorded cassette can't replay these.
 */
interface AblationSpec {
  /** Column labels for the comparison table. */
  arms: { on: string; off: string };
  onCfg: Partial<RunConfig>;
  offCfg: Partial<RunConfig>;
}

function ablationSpec(kind: AblationDim): AblationSpec {
  switch (kind) {
    case 'compaction':
      // Squeeze the window so even these short tasks approach the ceiling. Tasks
      // this small resolve before context is truly exhausted — the compaction
      // ablation is most meaningful on a long-context task (follow-up).
      return {
        arms: { on: 'on', off: 'off' },
        onCfg: { contextWindow: 20_000, maxOutputTokens: 4_000, compaction: 0.6 },
        offCfg: { contextWindow: 20_000, maxOutputTokens: 4_000, compaction: false },
      };
    case 'subagents':
      // Normal window. `on` offers the `task` tool (builtin sub-agents incl. the
      // read-only `explore` agent); `off` withholds it. On these small fixtures
      // the model rarely dispatches a sub-agent — the signal is clearest on a
      // large-repo exploration task (follow-up); the runner is the deliverable.
      return {
        arms: { on: 'task tool', off: 'no task tool' },
        onCfg: { subagents: true },
        offCfg: {},
      };
    case 'prompt-tools':
      // Normal window. `on` forces prompt-encoded tool calling (nativeTools off);
      // `off` uses the endpoint's native tool calling.
      return {
        arms: { on: 'prompt-encoded', off: 'native' },
        onCfg: { promptTools: true },
        offCfg: {},
      };
  }
}

async function runAblation(
  kind: AblationDim,
  tasks: Awaited<ReturnType<typeof loadTasks>>,
  base: RunConfig,
  model: string,
  resultsDir: string,
): Promise<void> {
  const arm = async (label: string, cfg: Partial<RunConfig>): Promise<TaskResult[]> => {
    const out: TaskResult[] = [];
    for (const t of tasks) {
      process.stderr.write(`· [${label}] ${t.spec.id} …\n`);
      out.push(await runTask(t, { ...base, live: true, ...cfg, label }));
    }
    return out;
  };

  const spec = ablationSpec(kind);
  // Labels seed trace ids / result buckets, so keep them filesystem-safe.
  const slug = (s: string): string => `${kind}-${s.replace(/\s+/g, '-')}`;
  const on = buildReport(await arm(slug(spec.arms.on), spec.onCfg), model);
  const off = buildReport(await arm(slug(spec.arms.off), spec.offCfg), model);
  await writeFile(join(resultsDir, `ablation-${kind}.json`), JSON.stringify({ on, off }, null, 2));
  process.stdout.write(`\n${renderComparison(kind, on, off, spec.arms)}\n`);
}

void main().catch((err: unknown) => {
  process.stderr.write(`eval: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
