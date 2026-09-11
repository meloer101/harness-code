/**
 * v1 routing is just the URL hash (docs/web-frontend.md, M3): `#/` is the
 * session list, `#/s/<id>` is one session. No router library — this also works
 * unchanged under a `file://` Electron shell later.
 *
 * The server hands the token over as `#token=…` on first load; `token.ts` (M4)
 * strips it, and until then anything that is not a route parses as home.
 */

export type Route = { kind: 'home' } | { kind: 'session'; id: string };

export function parseRoute(hash: string): Route {
  const match = /^#\/s\/([^/?#]+)\/?$/.exec(hash);
  if (match?.[1]) return { kind: 'session', id: decodeURIComponent(match[1]) };
  return { kind: 'home' };
}

export function routeToHash(route: Route): string {
  return route.kind === 'session' ? `#/s/${encodeURIComponent(route.id)}` : '#/';
}
