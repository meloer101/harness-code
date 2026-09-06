import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionState } from '../agent/session.js';
import type { AgentControl } from '../agent/control.js';
import { exitPlanModeTool } from './exit-plan-mode.js';

describe('exitPlanModeTool', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'hc-plan-'));
    await mkdir(join(cwd, '.agent'), { recursive: true }); // marks the project root
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const ctx = (control?: AgentControl) => ({ cwd, session: new SessionState(), ...(control ? { control } : {}) });

  async function planFiles(): Promise<string[]> {
    try {
      return await readdir(join(cwd, '.agent', 'plans'));
    } catch {
      return [];
    }
  }

  it('non-interactive: writes the file and ends the run', async () => {
    const res = await exitPlanModeTool.execute({ plan: '# Do the thing\n\nstep 1' }, ctx());
    expect(res.endsRun).toBe(true);
    expect(res.isError).toBeFalsy();
    const files = await planFiles();
    expect(files).toHaveLength(1);
    expect(res.content).toContain(files[0]!);
    const body = await readFile(join(cwd, '.agent', 'plans', files[0]!), 'utf8');
    expect(body).toContain('step 1');
  });

  it('approved: switches mode and does not end the run', async () => {
    let exited = 0;
    const control: AgentControl = {
      mode: 'plan',
      exitPlanMode: () => {
        exited++;
        return 'acceptEdits';
      },
      confirm: async () => ({ approved: true }),
    };
    const res = await exitPlanModeTool.execute({ plan: 'the plan', title: 'My Plan' }, ctx(control));
    expect(exited).toBe(1);
    expect(res.endsRun).toBeFalsy();
    expect(res.content).toMatch(/approved/i);
    expect(res.content).toContain('acceptEdits');
    expect(await planFiles()).toHaveLength(1);
  });

  it('rejected: keeps plan mode, threads feedback back, run continues', async () => {
    let exited = 0;
    const control: AgentControl = {
      mode: 'plan',
      exitPlanMode: () => {
        exited++;
        return 'acceptEdits';
      },
      confirm: async () => ({ approved: false, feedback: 'touch fewer files' }),
    };
    const res = await exitPlanModeTool.execute({ plan: 'the plan' }, ctx(control));
    expect(exited).toBe(0);
    expect(res.endsRun).toBeFalsy();
    expect(res.content).toContain('touch fewer files');
    expect(res.content).toMatch(/still in plan mode/i);
  });
});
