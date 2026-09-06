import { describe, expect, it } from 'vitest';

import { parseLooseJSON, stableStringify } from './json.js';

describe('parseLooseJSON', () => {
  it('parses valid JSON without applying repairs', () => {
    const r = parseLooseJSON('{"path":"src/index.ts","limit":10}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ path: 'src/index.ts', limit: 10 });
    expect(r.repairs).toEqual([]);
  });

  it('treats empty arguments as an empty object', () => {
    const r = parseLooseJSON('   ');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({});
  });

  // The five malformed shapes that actually show up, one per repair path.

  it('repair 1: strips markdown fences', () => {
    const r = parseLooseJSON('```json\n{"a": 1}\n```');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ a: 1 });
    expect(r.repairs).toContain('strip-code-fence');
  });

  it('repair 2: extracts the object out of surrounding prose', () => {
    const r = parseLooseJSON('Sure! Here you go: {"cmd": "ls -la"} — let me know.');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ cmd: 'ls -la' });
    expect(r.repairs).toContain('extract-balanced');
  });

  it('repair 3: normalizes smart quotes and Python literals', () => {
    const r = parseLooseJSON('{“recursive”: True, “ignore”: None}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ recursive: true, ignore: null });
    expect(r.repairs).toContain('normalize-literals');
  });

  it('repair 4: drops trailing commas', () => {
    const r = parseLooseJSON('{"a": 1, "b": [1, 2,],}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ a: 1, b: [1, 2] });
    expect(r.repairs).toContain('trailing-comma');
  });

  it('repair 5: closes output truncated mid-string by max_tokens', () => {
    const r = parseLooseJSON('{"path": "src/very/long/pa');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ path: 'src/very/long/pa' });
    expect(r.repairs).toContain('close-truncated');
  });

  it('closes output truncated between nested structures', () => {
    const r = parseLooseJSON('{"edits": [{"old": "a", "new": "b"}, {"old": "c"');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ edits: [{ old: 'a', new: 'b' }, { old: 'c' }] });
  });

  it('drops a dangling key that has no value yet', () => {
    const r = parseLooseJSON('{"path": "a.ts", "content":');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ path: 'a.ts' });
  });

  it('rewrites single quotes only when unambiguous', () => {
    const r = parseLooseJSON("{'name': 'grep'}");
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ name: 'grep' });
  });

  it('does not mangle apostrophes inside double-quoted strings', () => {
    const r = parseLooseJSON('{"msg": "it\'s fine"}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ msg: "it's fine" });
    expect(r.repairs).toEqual([]);
  });

  it('reports failure instead of inventing a value', () => {
    const r = parseLooseJSON('not json at all');
    expect(r.ok).toBe(false);
    expect(r.value).toBeUndefined();
    expect(r.error).toBeDefined();
  });
});

describe('stableStringify', () => {
  it('is insensitive to key order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
});
