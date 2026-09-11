import { describe, expect, it } from 'vitest';

import { parseRoute, routeToHash } from './route';

describe('parseRoute', () => {
  it('treats empty, root and unknown hashes as home', () => {
    expect(parseRoute('')).toEqual({ kind: 'home' });
    expect(parseRoute('#/')).toEqual({ kind: 'home' });
    expect(parseRoute('#/nope')).toEqual({ kind: 'home' });
  });

  it('does not mistake the token fragment for a route', () => {
    expect(parseRoute('#token=abc123')).toEqual({ kind: 'home' });
  });

  it('parses a session route, with or without a trailing slash', () => {
    expect(parseRoute('#/s/abc')).toEqual({ kind: 'session', id: 'abc' });
    expect(parseRoute('#/s/abc/')).toEqual({ kind: 'session', id: 'abc' });
  });

  it('round-trips ids that need encoding', () => {
    const route = { kind: 'session', id: '2026-09-11 a/b' } as const;
    expect(parseRoute(routeToHash(route))).toEqual(route);
  });
});
