import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { McpConnection } from './client.js';
import type { McpHttpServerConfig } from './config.js';
import { FileOAuthStore, OAuthNeedsLoginError, createOAuthProvider, serverSlug } from './oauth.js';
import { loginToServer } from './oauth-login.js';

// ---------------------------------------------------------------------------
// Unit: the store and the provider
// ---------------------------------------------------------------------------

describe('FileOAuthStore', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hc-oauth-store-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips client info and tokens, and clears them', async () => {
    const store = new FileOAuthStore('https://mcp.example.com/mcp', root);
    expect(await store.tokens()).toBeUndefined();

    await store.saveClientInformation({ client_id: 'c1', redirect_uris: ['http://127.0.0.1:8976/callback'] } as never);
    await store.saveTokens({ access_token: 'a', token_type: 'Bearer', refresh_token: 'r' } as never);

    expect(await store.clientInformation()).toMatchObject({ client_id: 'c1' });
    expect(await store.tokens()).toMatchObject({ access_token: 'a' });

    await store.clear();
    expect(await store.clientInformation()).toBeUndefined();
    expect(await store.tokens()).toBeUndefined();
  });
});

describe('createOAuthProvider', () => {
  const store = new FileOAuthStore('https://x/mcp', '/nonexistent-root-for-test');

  it('consume mode refuses with a "hc mcp login" hint', async () => {
    const p = createOAuthProvider({ serverUrl: 'https://x/mcp', store, mode: 'consume', serverName: 'linear' });
    await expect(p.redirectToAuthorization(new URL('https://x/authorize'))).rejects.toBeInstanceOf(
      OAuthNeedsLoginError,
    );
    await expect(p.redirectToAuthorization(new URL('https://x/authorize'))).rejects.toThrow(
      /hc mcp login linear/,
    );
  });

  it('interactive mode hands the URL to onAuthorize', async () => {
    let seen: string | undefined;
    const p = createOAuthProvider({
      serverUrl: 'https://x/mcp',
      store,
      mode: 'interactive',
      callbackUrl: 'http://127.0.0.1:8976/callback',
      onAuthorize: (u) => {
        seen = u.toString();
      },
    });
    await p.redirectToAuthorization(new URL('https://x/authorize?foo=1'));
    expect(seen).toBe('https://x/authorize?foo=1');
    expect(p.clientMetadata).toMatchObject({
      redirect_uris: ['http://127.0.0.1:8976/callback'],
      token_endpoint_auth_method: 'none',
    });
    expect(p.state?.()).toBe(p.state?.());
  });
});

// ---------------------------------------------------------------------------
// Integration: a mock OAuth AS + MCP server, end to end through loginToServer
// ---------------------------------------------------------------------------

describe('loginToServer (mock OAuth + MCP server)', () => {
  let http: HttpServer;
  let origin: string;
  let home: string;
  let realHome: string | undefined;
  const VALID = 'access-token-xyz';
  const authDir = (url: string): string => join(home, '.agent', 'mcp-auth', serverSlug(url));

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'hc-oauth-home-'));
    realHome = process.env.HOME;
    process.env.HOME = home;

    http = createServer((req, res) => void handle(req, res, origin, VALID));
    const port = await listen(http);
    origin = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => http.close(() => r()));
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    await rm(home, { recursive: true, force: true });
  });

  function config(): McpHttpServerConfig {
    return { name: 'mock', transport: 'http', url: `${origin}/mcp`, headers: {} };
  }

  it('completes the flow and caches tokens that a later connection reuses', async () => {
    const result = await loginToServer(config(), {
      // "open the browser" == follow the authorize redirect ourselves
      onAuthorize: async (url) => {
        await fetch(url, { redirect: 'follow' });
      },
      log: () => {},
    });
    expect(result.status).toBe('authorized');

    const tokens = JSON.parse(await readFile(join(authDir(`${origin}/mcp`), 'tokens.json'), 'utf8'));
    expect(tokens.access_token).toBe(VALID);

    // A plain connection (consume mode) now works off the cached token.
    const conn = new McpConnection(config());
    try {
      const tools = await conn.listTools();
      if (conn.state !== 'ready') throw new Error(`connection ${conn.state}: ${conn.error}`);
      expect(tools.map((t) => t.name)).toEqual(['ping']);
    } finally {
      await conn.close();
    }
  });

  it('an unauthorized connection fails with the login hint, not a crash', async () => {
    const conn = new McpConnection(config());
    try {
      const tools = await conn.listTools();
      expect(tools).toEqual([]);
      expect(conn.state).toBe('failed');
      expect(conn.error).toMatch(/hc mcp login mock/);
    } finally {
      await conn.close();
    }
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function listen(server: HttpServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string,
  validToken: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', origin);
  const json = (body: unknown, status = 200): void => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };

  if (url.pathname === '/.well-known/oauth-protected-resource') {
    return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
  }
  if (url.pathname === '/.well-known/oauth-authorization-server') {
    return json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  }
  if (url.pathname === '/register' && req.method === 'POST') {
    const meta = JSON.parse(await readBody(req));
    return json({ client_id: 'mock-client', client_id_issued_at: 1, ...meta }, 201);
  }
  if (url.pathname === '/authorize') {
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const to = new URL(redirectUri);
    to.searchParams.set('code', 'auth-code-1');
    if (state) to.searchParams.set('state', state);
    res.writeHead(302, { location: to.toString() }).end();
    return;
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    return json({
      access_token: validToken,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'refresh-1',
    });
  }
  if (url.pathname === '/mcp') {
    if (req.headers.authorization !== `Bearer ${validToken}`) {
      res
        .writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        })
        .end();
      return;
    }
    if (req.method === 'GET' || req.method === 'DELETE') {
      res.writeHead(405).end();
      return;
    }
    // Minimal MCP streamable-HTTP in JSON mode: one request in, one JSON-RPC out.
    const msg = JSON.parse(await readBody(req)) as { id?: unknown; method?: string; params?: { protocolVersion?: string } };
    if (msg.id === undefined) {
      res.writeHead(202).end(); // a notification (e.g. notifications/initialized)
      return;
    }
    const result =
      msg.method === 'initialize'
        ? {
            protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'mock', version: '0' },
          }
        : msg.method === 'tools/list'
          ? { tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' } }] }
          : {};
    json({ jsonrpc: '2.0', id: msg.id, result });
    return;
  }
  res.writeHead(404).end();
}
