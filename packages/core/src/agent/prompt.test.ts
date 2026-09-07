import { describe, expect, it } from 'vitest';

import { SYSTEM_SEGMENT_ORDER } from '../context/cache.js';
import { buildAgentSystemPrompt, buildSubagentSystemPrompt } from './prompt.js';

describe('buildAgentSystemPrompt', () => {
  it('orders segments identity, conventions, then environment', () => {
    const segments = buildAgentSystemPrompt({ cwd: '/workspace', platform: 'linux' });
    expect(segments.map((s) => s.id)).toEqual(['identity', 'conventions', 'environment']);
  });

  it('states the read-before-edit invariant enforced by the edit tool', () => {
    const [, conventions] = buildAgentSystemPrompt({ cwd: '/workspace', platform: 'linux' });
    expect(conventions?.text).toMatch(/read.*before editing/i);
  });

  it('includes the given cwd and platform in the environment segment', () => {
    const segments = buildAgentSystemPrompt({ cwd: '/workspace/project', platform: 'darwin' });
    const environment = segments.find((s) => s.id === 'environment');
    expect(environment?.text).toContain('/workspace/project');
    expect(environment?.text).toContain('darwin');
  });

  it('defaults platform to process.platform when omitted', () => {
    const segments = buildAgentSystemPrompt({ cwd: '/workspace' });
    const environment = segments.find((s) => s.id === 'environment');
    expect(environment?.text).toContain(process.platform);
  });

  it('marks conventions as a cache breakpoint ahead of the per-run environment segment', () => {
    const segments = buildAgentSystemPrompt({ cwd: '/workspace', platform: 'linux' });
    const conventions = segments.find((s) => s.id === 'conventions');
    expect(conventions?.cacheBreakpoint).toBe(true);
  });

  it('adds the plan_mode overlay only in plan mode, after the cacheable prefix', () => {
    const plain = buildAgentSystemPrompt({ cwd: '/w', platform: 'linux' });
    expect(plain.map((s) => s.id)).not.toContain('plan_mode');

    const plan = buildAgentSystemPrompt({ cwd: '/w', platform: 'linux', mode: 'plan' });
    expect(plan.map((s) => s.id)).toEqual(['identity', 'conventions', 'plan_mode', 'environment']);
    const overlay = plan.find((s) => s.id === 'plan_mode');
    expect(overlay?.text).toMatch(/exit_plan_mode/);
    expect(overlay?.cacheBreakpoint).toBeFalsy();
  });

  it('leaves the cacheable prefix (identity + conventions) byte-identical across modes', () => {
    const base = buildAgentSystemPrompt({ cwd: '/w', platform: 'linux' });
    for (const mode of ['ask', 'plan', 'acceptEdits', 'readOnly', 'yolo'] as const) {
      const withMode = buildAgentSystemPrompt({ cwd: '/w', platform: 'linux', mode });
      expect(withMode[0]).toEqual(base[0]);
      expect(withMode[1]).toEqual(base[1]);
    }
  });

  it('inserts a project_memory segment after conventions and before environment', () => {
    const segments = buildAgentSystemPrompt({
      cwd: '/w',
      platform: 'linux',
      projectMemory: '## /w/AGENTS.md\n\nuse 2-space indent',
    });
    expect(segments.map((s) => s.id)).toEqual(['identity', 'conventions', 'project_memory', 'environment']);
    const memory = segments.find((s) => s.id === 'project_memory');
    expect(memory?.text).toContain('use 2-space indent');
    expect(memory?.cacheBreakpoint).toBeFalsy();
  });

  it('inserts available_skills after conventions and before project_memory', () => {
    const segments = buildAgentSystemPrompt({
      cwd: '/w',
      platform: 'linux',
      skillsManifest: '<available_skills>\n- code-review: reviews code\n</available_skills>',
      projectMemory: '## /w/AGENTS.md\n\nnotes',
    });
    expect(segments.map((s) => s.id)).toEqual([
      'identity',
      'conventions',
      'available_skills',
      'project_memory',
      'environment',
    ]);
    expect(segments.find((s) => s.id === 'available_skills')?.text).toContain('code-review');
  });

  it('omits available_skills when the manifest is empty', () => {
    const segments = buildAgentSystemPrompt({ cwd: '/w', platform: 'linux', skillsManifest: '  ' });
    expect(segments.map((s) => s.id)).not.toContain('available_skills');
  });

  it('omits project_memory when the text is empty, keeping the segment order', () => {
    const segments = buildAgentSystemPrompt({ cwd: '/w', platform: 'linux', projectMemory: '   ' });
    expect(segments.map((s) => s.id)).toEqual(['identity', 'conventions', 'environment']);
  });

  it('keeps identity + conventions byte-identical when project memory is present', () => {
    const base = buildAgentSystemPrompt({ cwd: '/w', platform: 'linux' });
    const withMem = buildAgentSystemPrompt({ cwd: '/w', platform: 'linux', projectMemory: 'notes' });
    expect(withMem[0]).toEqual(base[0]);
    expect(withMem[1]).toEqual(base[1]);
  });

  it('always emits segments as a subsequence of SYSTEM_SEGMENT_ORDER', () => {
    for (const mode of ['ask', 'plan', 'acceptEdits', 'readOnly', 'yolo'] as const) {
      for (const projectMemory of [undefined, 'notes']) {
        const ids = buildAgentSystemPrompt({ cwd: '/w', platform: 'linux', mode, projectMemory }).map(
          (s) => s.id,
        );
        const ranks = ids.map((id) => (SYSTEM_SEGMENT_ORDER as readonly string[]).indexOf(id));
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
        expect(ranks).not.toContain(-1);
      }
    }
  });
});

describe('buildSubagentSystemPrompt', () => {
  it('places agent_role right after conventions, before environment', () => {
    const segs = buildSubagentSystemPrompt({ cwd: '/w', platform: 'linux', role: 'search the code' });
    expect(segs.map((s) => s.id)).toEqual(['identity', 'conventions', 'agent_role', 'environment']);
    expect(segs.find((s) => s.id === 'agent_role')?.text).toContain('search the code');
  });

  it('never carries skills or plan-mode segments', () => {
    const ids = buildSubagentSystemPrompt({
      cwd: '/w',
      platform: 'linux',
      role: 'r',
      projectMemory: 'notes',
    }).map((s) => s.id);
    expect(ids).not.toContain('available_skills');
    expect(ids).not.toContain('plan_mode');
    expect(ids).toContain('project_memory');
  });

  it('keeps identity + conventions byte-identical to the main prompt (cache still hits)', () => {
    const main = buildAgentSystemPrompt({ cwd: '/w', platform: 'linux' });
    const sub = buildSubagentSystemPrompt({ cwd: '/w', platform: 'linux', role: 'r' });
    expect(sub[0]).toEqual(main[0]);
    expect(sub[1]).toEqual(main[1]);
  });

  it('emits segments as a subsequence of SYSTEM_SEGMENT_ORDER', () => {
    const ids = buildSubagentSystemPrompt({
      cwd: '/w',
      platform: 'linux',
      role: 'r',
      projectMemory: 'n',
    }).map((s) => s.id);
    const ranks = ids.map((id) => (SYSTEM_SEGMENT_ORDER as readonly string[]).indexOf(id));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(ranks).not.toContain(-1);
  });
});
