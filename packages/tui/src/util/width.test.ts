import { describe, expect, it } from 'vitest';

import { pad, truncate, width } from './width.js';

describe('width utils', () => {
  it('counts CJK as 2 columns', () => {
    expect(width('你好world')).toBe(9); // 2 + 2 + 5
    expect(width('abc')).toBe(3);
    expect(width('')).toBe(0);
  });

  it('truncates to a display width, never exceeding it', () => {
    const t = truncate('hello world', 8);
    expect(width(t)).toBeLessThanOrEqual(8);
    expect(t).toContain('…');
  });

  it('leaves short strings alone', () => {
    expect(truncate('hi', 8)).toBe('hi');
  });

  it('pads to a display width', () => {
    expect(pad('ab', 4)).toBe('ab  ');
    expect(pad('ab', 4, 'right')).toBe('  ab');
    expect(pad('你好', 4)).toBe('你好');
  });
});
