import { describe, expect, it } from 'vitest';

import type { AnyToolSpec } from '../tools/types.js';
import { allowedToolNames, narrowToolSpecs } from './narrow.js';

const spec = (name: string): AnyToolSpec =>
  ({ name, description: '', readOnly: true, concurrencySafe: true }) as unknown as AnyToolSpec;

const all = ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'todo', 'skill', 'memory'].map(spec);
const names = (specs: readonly AnyToolSpec[]) => specs.map((s) => s.name).sort();

describe('narrowToolSpecs', () => {
  it('is a no-op when no active skill declares allowed-tools', () => {
    expect(names(narrowToolSpecs(all, [{ name: 'x' }]))).toEqual(names(all));
  });

  it('filters to the declared tools, always keeping skill, todo, and memory', () => {
    const out = narrowToolSpecs(all, [{ name: 'x', allowedTools: ['Read', 'Grep'] }]);
    expect(names(out)).toEqual(['grep', 'memory', 'read', 'skill', 'todo']);
  });

  it('matches a Bash(specifier) rule by tool name', () => {
    const out = narrowToolSpecs(all, [{ name: 'x', allowedTools: ['Read', 'Bash(npm test:*)'] }]);
    expect(names(out)).toContain('bash');
  });

  it('intersects across multiple active skills', () => {
    const out = narrowToolSpecs(all, [
      { name: 'a', allowedTools: ['Read', 'Grep', 'Edit'] },
      { name: 'b', allowedTools: ['Read', 'Edit', 'Write'] },
    ]);
    expect(names(out)).toEqual(['edit', 'memory', 'read', 'skill', 'todo']);
  });

  it('matches mcp tools by server rule', () => {
    const withMcp = [...all, spec('mcp__github__create_issue')];
    const out = narrowToolSpecs(withMcp, [{ name: 'x', allowedTools: ['mcp__github'] }]);
    expect(names(out)).toContain('mcp__github__create_issue');
  });

  it('keeps exit_plan_mode when it is registered, so a plan-mode skill can leave plan mode', () => {
    const withExit = [...all, spec('exit_plan_mode')];
    const out = narrowToolSpecs(withExit, [{ name: 'x', allowedTools: ['Read'] }]);
    expect(names(out)).toContain('exit_plan_mode');
  });
});

describe('allowedToolNames', () => {
  it('returns undefined when no active skill declares allowed-tools', () => {
    expect(allowedToolNames(all, [{ name: 'x' }])).toBeUndefined();
    expect(allowedToolNames(all, [])).toBeUndefined();
  });

  it('returns the allowed names plus skill, todo, and memory', () => {
    expect(allowedToolNames(all, [{ name: 'x', allowedTools: ['Read', 'Grep'] }])?.sort()).toEqual([
      'grep',
      'memory',
      'read',
      'skill',
      'todo',
    ]);
  });

  it('intersects across multiple active skills', () => {
    expect(
      allowedToolNames(all, [
        { name: 'a', allowedTools: ['Read', 'Grep', 'Edit'] },
        { name: 'b', allowedTools: ['Read', 'Edit', 'Write'] },
      ])?.sort(),
    ).toEqual(['edit', 'memory', 'read', 'skill', 'todo']);
  });

  it('matches mcp tools by server rule', () => {
    const withMcp = [...all, spec('mcp__github__create_issue')];
    expect(allowedToolNames(withMcp, [{ name: 'x', allowedTools: ['mcp__github'] }])).toContain(
      'mcp__github__create_issue',
    );
  });
});
