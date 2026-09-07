import { describe, expect, it } from 'vitest';

import type { AnyToolSpec } from '../tools/types.js';
import { narrowToolSpecs } from './narrow.js';

const spec = (name: string): AnyToolSpec =>
  ({ name, description: '', readOnly: true, concurrencySafe: true }) as unknown as AnyToolSpec;

const all = ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'todo', 'skill'].map(spec);
const names = (specs: readonly AnyToolSpec[]) => specs.map((s) => s.name).sort();

describe('narrowToolSpecs', () => {
  it('is a no-op when no active skill declares allowed-tools', () => {
    expect(names(narrowToolSpecs(all, [{ name: 'x' }]))).toEqual(names(all));
  });

  it('filters to the declared tools, always keeping skill and todo', () => {
    const out = narrowToolSpecs(all, [{ name: 'x', allowedTools: ['Read', 'Grep'] }]);
    expect(names(out)).toEqual(['grep', 'read', 'skill', 'todo']);
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
    expect(names(out)).toEqual(['edit', 'read', 'skill', 'todo']);
  });

  it('matches mcp tools by server rule', () => {
    const withMcp = [...all, spec('mcp__github__create_issue')];
    const out = narrowToolSpecs(withMcp, [{ name: 'x', allowedTools: ['mcp__github'] }]);
    expect(names(out)).toContain('mcp__github__create_issue');
  });
});
