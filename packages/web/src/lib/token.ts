/**
 * The server hands the auth token over as `#token=…` on the URL it prints
 * (docs/web.md, "Security"). On load we move it into `sessionStorage` — so a
 * reload keeps working — and scrub it from the address bar so it doesn't end
 * up in screenshots, history, or a copied link.
 */

const KEY = 'hc.token';

export interface TokenEnv {
  location: { hash: string; pathname: string; search: string };
  history: { replaceState(data: unknown, unused: string, url?: string): void };
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
}

export function takeToken(env: TokenEnv = defaultEnv()): string | null {
  const match = /^#token=([0-9a-fA-F]+)$/.exec(env.location.hash);
  if (match?.[1]) {
    const token = match[1];
    try {
      env.storage.setItem(KEY, token);
    } catch {
      // storage blocked — the token still works for this page load
    }
    env.history.replaceState(null, '', `${env.location.pathname}${env.location.search}#/`);
    return token;
  }
  try {
    return env.storage.getItem(KEY);
  } catch {
    return null;
  }
}

function defaultEnv(): TokenEnv {
  return { location: window.location, history: window.history, storage: window.sessionStorage };
}
