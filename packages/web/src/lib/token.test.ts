import { describe, expect, it } from 'vitest';

import { takeToken } from './token';
import type { TokenEnv } from './token';

function env(hash: string, stored: string | null = null) {
  const store = new Map<string, string>();
  if (stored) store.set('hc.token', stored);
  const replaced: string[] = [];
  const e: TokenEnv = {
    location: { hash, pathname: '/', search: '' },
    history: { replaceState: (_d, _u, url) => replaced.push(String(url)) },
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
  };
  return { e, store, replaced };
}

describe('takeToken', () => {
  it('takes the token from the hash, stores it, and scrubs the URL', () => {
    const { e, store, replaced } = env('#token=abc123');
    expect(takeToken(e)).toBe('abc123');
    expect(store.get('hc.token')).toBe('abc123');
    expect(replaced).toEqual(['/#/']);
  });

  it('falls back to the stored token on reload', () => {
    const { e, replaced } = env('#/s/x', 'def456');
    expect(takeToken(e)).toBe('def456');
    expect(replaced).toEqual([]);
  });

  it('returns null with neither', () => {
    expect(takeToken(env('').e)).toBeNull();
  });
});
