import { describe, expect, it } from 'vitest';

import { PRUNED_TOOL_RESULT_PREFIX } from '../context/compactor.js';
import { shouldVaryObservation, varyObservation } from './observations.js';

describe('varyObservation', () => {
  it('is deterministic for a given toolUseId', () => {
    const a = varyObservation('hello', 'call_1');
    const b = varyObservation('hello', 'call_1');
    expect(a).toBe(b);
    expect(a).toContain('hello');
  });

  it('uses different wrappers for different ids (not all identity)', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `call_${i}`);
    const variants = new Set(ids.map((id) => varyObservation('hello', id)));
    expect(variants.size).toBeGreaterThan(1);
  });
});

describe('shouldVaryObservation', () => {
  it('skips errors, empty bodies, and pruned placeholders', () => {
    expect(shouldVaryObservation({ content: 'ok' })).toBe(true);
    expect(shouldVaryObservation({ content: 'ok', isError: true })).toBe(false);
    expect(shouldVaryObservation({ content: '' })).toBe(false);
    expect(
      shouldVaryObservation({
        content: `${PRUNED_TOOL_RESULT_PREFIX} bash, 9 chars] Cleared.`,
      }),
    ).toBe(false);
    expect(shouldVaryObservation({ content: 'Denied: no' })).toBe(false);
    expect(shouldVaryObservation({ content: 'Unknown tool "x"' })).toBe(false);
  });
});
