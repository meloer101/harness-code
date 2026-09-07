import { describe, expect, it } from 'vitest';

import type { SystemSegment } from '../provider/types.js';
import { SYSTEM_SEGMENT_ORDER, cacheHitRate, orderSystemSegments } from './cache.js';

const seg = (id: string): SystemSegment => ({ id, text: id });

describe('orderSystemSegments', () => {
  it('sorts into the canonical order', () => {
    const out = orderSystemSegments([seg('environment'), seg('identity'), seg('conventions')]);
    expect(out.map((s) => s.id)).toEqual(['identity', 'conventions', 'environment']);
  });

  it('puts unknown ids last, preserving their relative order', () => {
    const out = orderSystemSegments([seg('zeta'), seg('identity'), seg('alpha')]);
    expect(out.map((s) => s.id)).toEqual(['identity', 'zeta', 'alpha']);
  });

  it('is a no-op on already-ordered input', () => {
    const input = SYSTEM_SEGMENT_ORDER.map(seg);
    expect(orderSystemSegments(input).map((s) => s.id)).toEqual([...SYSTEM_SEGMENT_ORDER]);
  });
});

describe('cacheHitRate', () => {
  it('is 0 when there is no input', () => {
    expect(cacheHitRate({ inputTokens: 0, cachedInputTokens: 0 })).toBe(0);
  });

  it('is the cached fraction of input', () => {
    expect(cacheHitRate({ inputTokens: 1000, cachedInputTokens: 800 })).toBe(0.8);
  });
});
