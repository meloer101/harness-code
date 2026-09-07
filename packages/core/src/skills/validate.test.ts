import { describe, expect, it } from 'vitest';

import { parseSkill } from './validate.js';

const frontmatter = (fields: Record<string, string>): string =>
  ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', '', 'Body text.'].join(
    '\n',
  );

const parse = (raw: string, dirName = 'demo') =>
  parseSkill({ raw, dirName, dir: `/skills/${dirName}`, source: 'project' });

describe('parseSkill', () => {
  it('accepts a minimal valid skill', () => {
    const r = parse(frontmatter({ name: 'demo', description: 'Does a demo thing. Use when demoing.' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skill.name).toBe('demo');
      expect(r.skill.body).toBe('Body text.');
      expect(r.skill.source).toBe('project');
    }
  });

  it('parses optional license, metadata, and allowed-tools', () => {
    const raw = [
      '---',
      'name: demo',
      'description: d',
      'license: Apache-2.0',
      'allowed-tools: Read Grep Bash(git diff:*)',
      'metadata:',
      '  author: me',
      '  version: "1.0"',
      '---',
      'B',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skill.license).toBe('Apache-2.0');
      expect(r.skill.allowedTools).toEqual(['Read', 'Grep', 'Bash(git diff:*)']);
      expect(r.skill.metadata).toEqual({ author: 'me', version: '1.0' });
    }
  });

  it('rejects a missing name', () => {
    const r = parse(frontmatter({ description: 'd' }));
    expect(r).toMatchObject({ ok: false });
  });

  it('rejects a missing or empty description', () => {
    expect(parse(frontmatter({ name: 'demo' }))).toMatchObject({ ok: false });
    expect(parse(frontmatter({ name: 'demo', description: '""' }))).toMatchObject({ ok: false });
  });

  it('rejects a name that does not match the directory', () => {
    const r = parse(frontmatter({ name: 'other', description: 'd' }), 'demo');
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toMatch(/directory/);
  });

  it('rejects an invalid name shape', () => {
    for (const name of ['Demo', '-demo', 'demo-', 'demo--x', 'de mo']) {
      expect(parse(frontmatter({ name, description: 'd' }), name)).toMatchObject({ ok: false });
    }
  });

  it('rejects an over-long description', () => {
    const r = parse(frontmatter({ name: 'demo', description: 'x'.repeat(1025) }));
    expect(r).toMatchObject({ ok: false });
  });

  it('reports malformed YAML rather than throwing', () => {
    const r = parse('---\nname: [unclosed\n---\nB');
    expect(r).toMatchObject({ ok: false });
  });
});
