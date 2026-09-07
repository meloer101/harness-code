import { describe, expect, it } from 'vitest';

import { truncateHeadTail, truncateList } from './truncate.js';

describe('truncateHeadTail', () => {
  it('returns short text unchanged', () => {
    const r = truncateHeadTail('hello\nworld', { maxChars: 100 });
    expect(r.truncated).toBe(false);
    expect(r.text).toBe('hello\nworld');
    expect(r.omittedChars).toBe(0);
  });

  it('keeps head and tail, drops the middle, and reports what was omitted', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    const r = truncateHeadTail(lines, { maxChars: 200, headChars: 60, tailChars: 60 });

    expect(r.truncated).toBe(true);
    expect(r.text.startsWith('line 0\n')).toBe(true);
    expect(r.text.trimEnd().endsWith('line 399')).toBe(true);
    expect(r.text).toMatch(/characters \/ \d+ lines omitted/);
    expect(r.omittedLines).toBeGreaterThan(0);
  });

  it('cuts on a line boundary when a newline is near the cut point', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `row${i}`).join('\n');
    const r = truncateHeadTail(lines, { maxChars: 50, headChars: 25, tailChars: 25 });
    const head = r.text.split('\n… ')[0];
    // every kept head line is intact (no partial "ro")
    for (const line of head!.split('\n').filter(Boolean)) expect(line).toMatch(/^row\d+$/);
  });

  it('hard-cuts a single huge line with no newlines', () => {
    const r = truncateHeadTail('x'.repeat(50_000), { maxChars: 30_000, headChars: 20_000, tailChars: 8_000 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThan(30_000);
    expect(r.text).toMatch(/omitted/);
  });
});

describe('truncateList', () => {
  it('returns all items when at or below the cap', () => {
    const r = truncateList(['a', 'b', 'c'], 5);
    expect(r.text).toBe('a\nb\nc');
    expect(r.shown).toBe(3);
  });

  it('caps and states the true total', () => {
    const items = Array.from({ length: 250 }, (_, i) => `m${i}`);
    const r = truncateList(items, 200, { noun: 'matches' });
    expect(r.shown).toBe(200);
    expect(r.text).toContain('showing 200 of 250 matches');
    expect(r.text.split('\n').filter((l) => l.startsWith('m'))).toHaveLength(200);
  });

  it('says "at least" when the total is only a floor', () => {
    const items = Array.from({ length: 200 }, (_, i) => `m${i}`);
    const r = truncateList(items, 200, { noun: 'matches', totalIsFloor: true, total: 200 });
    expect(r.text).toContain('showing 200 of at least 200 matches');
  });
});
