import { describe, expect, it } from 'vitest';

import { parseAgent } from './validate.js';

const fm = (fields: Record<string, string>, body = 'Role instructions.'): string =>
  ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', '', body].join('\n');

const parse = (raw: string, stem = 'explore') => parseAgent({ raw, stem, source: 'builtin' });

describe('parseAgent', () => {
  it('accepts a valid definition and parses tools + model', () => {
    const r = parse(fm({ name: 'explore', description: 'search', tools: 'read, glob grep', model: 'x/y' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.agent.tools).toEqual(['read', 'glob', 'grep']);
      expect(r.agent.model).toBe('x/y');
      expect(r.agent.body).toBe('Role instructions.');
    }
  });

  it('treats tools as optional (inherit all)', () => {
    const r = parse(fm({ name: 'explore', description: 'd' }));
    expect(r.ok && r.agent.tools).toBeUndefined();
  });

  it('rejects name/file mismatch, missing description, empty body', () => {
    expect(parse(fm({ name: 'other', description: 'd' }), 'explore')).toMatchObject({ ok: false });
    expect(parse(fm({ name: 'explore' }))).toMatchObject({ ok: false });
    expect(parse(fm({ name: 'explore', description: 'd' }, '   '))).toMatchObject({ ok: false });
  });

  it('reports malformed YAML rather than throwing', () => {
    expect(parse('---\nname: [x\n---\nbody')).toMatchObject({ ok: false });
  });
});
