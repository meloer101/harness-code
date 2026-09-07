import { describe, expect, it } from 'vitest';

import { SessionState } from '../agent/session.js';
import type { ActiveSkill } from '../agent/control.js';
import { SkillCatalog } from './catalog.js';
import { createSkillTool } from './skill-tool.js';
import type { Skill } from './types.js';

const skill = (over: Partial<Skill> = {}): Skill => ({
  name: 'writing-tests',
  description: 'write tests',
  body: '# Writing tests\n\ndo the thing',
  dir: '/skills/writing-tests',
  source: 'builtin',
  ...over,
});

function ctx(activated: ActiveSkill[]) {
  return {
    cwd: '/w',
    session: new SessionState(),
    control: {
      mode: 'ask' as const,
      exitPlanMode: () => 'ask' as const,
      activateSkill: (s: ActiveSkill) => activated.push(s),
    },
  };
}

describe('skill tool', () => {
  it('returns the skill body and records activation', async () => {
    const activated: ActiveSkill[] = [];
    const tool = createSkillTool(new SkillCatalog([skill()]));
    const res = await tool.execute({ name: 'writing-tests' }, ctx(activated));
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('do the thing');
    expect(activated).toEqual([{ name: 'writing-tests' }]);
  });

  it('passes allowed-tools through on activation', async () => {
    const activated: ActiveSkill[] = [];
    const tool = createSkillTool(new SkillCatalog([skill({ allowedTools: ['Read', 'Grep'] })]));
    await tool.execute({ name: 'writing-tests' }, ctx(activated));
    expect(activated[0]).toEqual({ name: 'writing-tests', allowedTools: ['Read', 'Grep'] });
  });

  it('errors with the list of known skills on an unknown name', async () => {
    const tool = createSkillTool(new SkillCatalog([skill({ name: 'code-review' })]));
    const res = await tool.execute({ name: 'nope' }, ctx([]));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('code-review');
  });

  it('is read-only and concurrency-safe', () => {
    const tool = createSkillTool(new SkillCatalog([]));
    expect(tool.readOnly).toBe(true);
    expect(tool.concurrencySafe).toBe(true);
  });
});
