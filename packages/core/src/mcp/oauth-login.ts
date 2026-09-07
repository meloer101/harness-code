/**
 * The interactive half of MCP OAuth: `hc mcp login <server>`.
 *
 * Stands up a loopback HTTP server to catch the redirect, kicks off the SDK's
 * auth flow (which opens a browser), waits for the `?code=`, finishes the token
 * exchange, and verifies the tokens work. Everything it persists goes through
 * `FileOAuthStore`, so a later non-interactive run just reads the cached tokens.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

import { VERSION } from '../version.js';
import { buildAuthTransport } from './client.js';
import type { McpHttpServerConfig } from './config.js';
import { FileOAuthStore, createOAuthProvider } from './oauth.js';

const DEFAULT_PORTS = [8976, 8977, 8978, 0];
const CALLBACK_TIMEOUT_MS = 300_000;

export interface LoginOptions {
  /** Override the browser open (tests pass a fetch). Receives the authorization URL. */
  onAuthorize?: (url: URL) => void | Promise<void>;
  preferredPorts?: number[];
  /** Store root override (tests point this at a temp dir). */
  storeRoot?: string;
  /** Where progress lines go. Defaults to stderr. */
  log?: (line: string) => void;
}

export interface LoginResult {
  status: 'authorized' | 'already-authorized';
}

export async function loginToServer(
  config: McpHttpServerConfig,
  opts: LoginOptions = {},
): Promise<LoginResult> {
  const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const store = new FileOAuthStore(config.url, opts.storeRoot);

  let capturedCode: string | undefined;
  let capturedState: string | undefined;
  let resolveCallback: () => void = () => {};
  const callbackHit = new Promise<void>((resolve) => {
    resolveCallback = resolve;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/callback')) {
      res.writeHead(404).end();
      return;
    }
    capturedCode = url.searchParams.get('code') ?? undefined;
    capturedState = url.searchParams.get('state') ?? undefined;
    const err = url.searchParams.get('error');
    res.writeHead(200, { 'content-type': 'text/html' }).end(
      `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:2rem">` +
        (err
          ? `<h3>Authorization failed</h3><p>${escapeHtml(err)}</p>`
          : `<h3>Authorized</h3><p>You can close this tab and return to the terminal.</p>`) +
        `</body>`,
    );
    resolveCallback();
  });

  const port = await listenOnFirst(server, opts.preferredPorts ?? DEFAULT_PORTS);
  const callbackUrl = `http://127.0.0.1:${port}/callback`;

  // If a prior registration used a different redirect URI, it will not match
  // this run's port — re-register from scratch.
  const existing = await store.clientInformation();
  if (existing && !(existing.redirect_uris ?? []).includes(callbackUrl)) {
    await store.clear();
  }

  const provider = createOAuthProvider({
    serverUrl: config.url,
    store,
    mode: 'interactive',
    callbackUrl,
    serverName: config.name,
    ...(opts.onAuthorize ? { onAuthorize: opts.onAuthorize } : {}),
  });

  const client = new Client({ name: 'harness-code', version: VERSION }, { capabilities: {} });

  try {
    try {
      await client.connect(buildAuthTransport(config, provider));
      // Connected without a redirect — tokens were already valid.
      await client.close();
      return { status: 'already-authorized' };
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
    }

    log('\x1b[2mwaiting for authorization in your browser…\x1b[0m');
    await withTimeout(callbackHit, CALLBACK_TIMEOUT_MS, 'timed out waiting for the OAuth redirect');

    if (!capturedCode) throw new Error('OAuth redirect carried no authorization code');
    const expectedState = await provider.state?.();
    if (expectedState && capturedState !== expectedState) {
      throw new Error('OAuth state mismatch — aborting (possible CSRF)');
    }

    const finishTransport = buildAuthTransport(config, provider);
    await finishTransport.finishAuth(capturedCode);

    // Fresh transport, now with tokens on disk, to confirm the grant works.
    const verifyClient = new Client(
      { name: 'harness-code', version: VERSION },
      { capabilities: {} },
    );
    await verifyClient.connect(buildAuthTransport(config, provider));
    await verifyClient.close();
    await finishTransport.close().catch(() => {});
    return { status: 'authorized' };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function listenOnFirst(
  server: ReturnType<typeof createServer>,
  ports: number[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (i: number): void => {
      if (i >= ports.length) {
        reject(new Error(`could not bind a loopback callback port (tried ${ports.join(', ')})`));
        return;
      }
      const onError = (): void => {
        server.removeListener('error', onError);
        tryPort(i + 1);
      };
      server.once('error', onError);
      server.listen(ports[i], '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve((server.address() as AddressInfo).port);
      });
    };
    tryPort(0);
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}
