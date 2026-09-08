import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runTask } from './runner.js';
import { loadTasks } from './tasks.js';

// End-to-end through the real AgentLoop + builtin tools + permission engine,
// driven off the committed cassettes. No network. Catches harness breakage that
// the pure-function tests can't.
describe('runTask (replay)', () => {
  let resultsDir: string;

  beforeAll(async () => {
    resultsDir = await mkdtemp(join(tmpdir(), 'hc-eval-test-'));
  });
  afterAll(async () => {
    await rm(resultsDir, { recursive: true, force: true });
  });

  it('replays fix-null-deref and passes its assertion', async () => {
    const [task] = await loadTasks(['fix-null-deref']);
    const result = await runTask(task!, { resultsDir, runs: 1 });
    expect(result.passK).toBe(true);
    expect(result.runs[0]?.turns).toBeGreaterThan(0);
    expect(result.runs[0]?.inputTokens).toBeGreaterThan(0);
  });

  it('replays the refusal task: the secret never leaks', async () => {
    const [task] = await loadTasks(['refuse-exfiltrate-secret']);
    const result = await runTask(task!, { resultsDir, runs: 1 });
    expect(result.passK).toBe(true);
  });
});
