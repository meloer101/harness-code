/**
 * OAuth for remote MCP servers (Linear, Notion, Slack, …).
 *
 * The SDK's transports do the protocol work — discovery, dynamic client
 * registration, PKCE, the token exchange and silent refresh — through an
 * `OAuthClientProvider` we supply. This file is that provider plus a file-backed
 * store for what has to persist between runs: the registered client and the
 * tokens, under `~/.agent/mcp-auth/<slug>/`.
 *
 * Two modes:
 *   - `interactive` — `redirectToAuthorization` opens a browser. Used by
 *     `hc mcp login`.
 *   - `consume` (default) — `redirectToAuthorization` throws "run hc mcp login".
 *     Used everywhere else. Silent refresh still works here; only the
 *     browser-in-the-loop first authorization is refused.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import { AGENT_DIR } from '../config/settings.js';

export function mcpAuthRoot(): string {
  return join(homedir(), AGENT_DIR, 'mcp-auth');
}

/** `mcp.linear.app_1a2b3c4d` — readable host + enough hash to disambiguate. */
export function serverSlug(serverUrl: string): string {
  let host = 'server';
  try {
    host = new URL(serverUrl).host.replace(/[^A-Za-z0-9.-]/g, '_');
  } catch {
    // fall through
  }
  const hash = createHash('sha256').update(serverUrl).digest('hex').slice(0, 8);
  return `${host}_${hash}`;
}

export function mcpAuthDir(serverUrl: string): string {
  return join(mcpAuthRoot(), serverSlug(serverUrl));
}

/** Persists the registered client and tokens for one server. */
export class FileOAuthStore {
  private readonly dir: string;

  constructor(serverUrl: string, root?: string) {
    this.dir = root ? join(root, serverSlug(serverUrl)) : mcpAuthDir(serverUrl);
  }

  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    return this.readJson('client.json');
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await this.writeJson('client.json', info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.readJson('tokens.json');
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.writeJson('tokens.json', tokens);
  }

  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  private async readJson<T>(name: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dir, name), 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  private async writeJson(name: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(join(this.dir, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  }
}

export interface OAuthProviderOptions {
  serverUrl: string;
  store: FileOAuthStore;
  /** `interactive` opens a browser; `consume` refuses with a "run hc mcp login" error. */
  mode: 'interactive' | 'consume';
  /** Loopback redirect URI. Required for `interactive`. */
  callbackUrl?: string;
  /** Server name, only for the error message in `consume` mode. */
  serverName?: string;
  scope?: string;
  /** Called with the authorization URL in `interactive` mode. Defaults to opening a browser. */
  onAuthorize?: (url: URL) => void | Promise<void>;
}

export class OAuthNeedsLoginError extends Error {
  constructor(serverName: string) {
    super(`needs authorization — run: hc mcp login ${serverName}`);
    this.name = 'OAuthNeedsLoginError';
  }
}

export function createOAuthProvider(opts: OAuthProviderOptions): OAuthClientProvider {
  const codeVerifiers = new Map<string, string>();
  let stateValue: string | undefined;

  // The SDK treats a missing `redirectUrl` as a non-interactive (client-
  // credentials) flow. We always want the authorization-code flow — in consume
  // mode we just intercept `redirectToAuthorization` and refuse — so a
  // placeholder loopback URL stands in when no real callback is running.
  const redirect = opts.callbackUrl ?? 'http://127.0.0.1:0/callback';

  return {
    get redirectUrl(): string {
      return redirect;
    },

    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: 'harness-code',
        redirect_uris: [redirect],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(opts.scope ? { scope: opts.scope } : {}),
      };
    },

    state(): string {
      if (!stateValue) stateValue = randomBytes(16).toString('hex');
      return stateValue;
    },

    async clientInformation(): Promise<OAuthClientInformation | undefined> {
      return opts.store.clientInformation();
    },

    async saveClientInformation(info): Promise<void> {
      await opts.store.saveClientInformation(info as OAuthClientInformationFull);
    },

    async tokens(): Promise<OAuthTokens | undefined> {
      return opts.store.tokens();
    },

    async saveTokens(tokens): Promise<void> {
      await opts.store.saveTokens(tokens);
    },

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
      if (opts.mode !== 'interactive') {
        throw new OAuthNeedsLoginError(opts.serverName ?? opts.serverUrl);
      }
      const handler = opts.onAuthorize ?? ((u: URL) => openBrowser(u.toString()));
      await handler(authorizationUrl);
    },

    saveCodeVerifier(codeVerifier: string): void {
      codeVerifiers.set('current', codeVerifier);
    },

    codeVerifier(): string {
      const v = codeVerifiers.get('current');
      if (!v) throw new Error('No PKCE code verifier saved for this session');
      return v;
    },
  };
}

/**
 * Open a URL in the user's browser, best-effort. The URL is always printed to
 * stderr as well, so a headless or SSH session can copy it.
 */
export function openBrowser(url: string): void {
  process.stderr.write(`\x1b[2mopen this URL to authorize:\x1b[0m\n${url}\n`);
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // the printed URL is the fallback
  }
}
