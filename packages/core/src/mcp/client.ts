/**
 * One connection to one MCP server.
 *
 * Lazy: the process is not spawned (nor the HTTP session opened) until the
 * first call that needs it. Failure is contained — a connect timeout or a
 * handshake error puts the connection in `failed` and is surfaced through
 * `error`, never thrown into the agent loop. The hub treats a failed
 * connection as "this server's tools are unavailable" and moves on.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { VERSION } from '../version.js';
import type { McpHttpServerConfig, McpServerConfig } from './config.js';
import { FileOAuthStore, OAuthNeedsLoginError, createOAuthProvider } from './oauth.js';

/**
 * Build the transport for a remote (http/sse) server. `sse` uses the older
 * transport; everything else uses streamable HTTP. An `authProvider` wires in
 * OAuth — token attach, silent refresh, and (in `hc mcp login`) the browser
 * redirect.
 */
export function buildAuthTransport(
  config: McpHttpServerConfig,
  authProvider?: OAuthClientProvider,
): StreamableHTTPClientTransport | SSEClientTransport {
  const url = new URL(config.url);
  const requestInit = { headers: config.headers };
  return config.transport === 'sse'
    ? new SSEClientTransport(url, { requestInit, ...(authProvider ? { authProvider } : {}) })
    : new StreamableHTTPClientTransport(url, { requestInit, ...(authProvider ? { authProvider } : {}) });
}

/**
 * The provider a plain connection uses: `consume` mode, so a missing/expired
 * token that cannot be refreshed fails with "run hc mcp login" rather than
 * trying to open a browser mid-run. Returns undefined when the server is
 * static-auth (an `Authorization` header, or `auth: "none"`).
 */
function httpAuthProvider(config: McpHttpServerConfig): OAuthClientProvider | undefined {
  if (config.auth === 'none') return undefined;
  const hasStaticAuth = Object.keys(config.headers).some((h) => h.toLowerCase() === 'authorization');
  if (hasStaticAuth && config.auth !== 'oauth') return undefined;
  return createOAuthProvider({
    serverUrl: config.url,
    store: new FileOAuthStore(config.url),
    mode: 'consume',
    serverName: config.name,
  });
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export type McpConnectionState = 'idle' | 'connecting' | 'ready' | 'failed';

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export class McpConnection {
  readonly name: string;
  private readonly config: McpServerConfig;
  private readonly connectTimeoutMs: number;
  private client: Client | undefined;
  private connectPromise: Promise<void> | undefined;
  private _state: McpConnectionState = 'idle';
  private _error: string | undefined;

  constructor(config: McpServerConfig, opts: { connectTimeoutMs?: number } = {}) {
    this.name = config.name;
    this.config = config;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  get state(): McpConnectionState {
    return this._state;
  }

  get error(): string | undefined {
    return this._error;
  }

  /**
   * Connect if not already connected. Never rejects: on failure it records the
   * reason and returns, leaving `state === 'failed'`. Callers check `state`.
   */
  async ensureConnected(): Promise<void> {
    if (this._state === 'ready' || this._state === 'failed') return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connect();
    return this.connectPromise;
  }

  private async connect(): Promise<void> {
    this._state = 'connecting';
    const client = new Client(
      { name: 'harness-code', version: VERSION },
      { capabilities: {} },
    );
    try {
      if (this.config.transport === 'stdio') {
        await this.attempt(client, this.stdioTransport(this.config));
      } else {
        const provider = httpAuthProvider(this.config);
        try {
          await this.attempt(client, buildAuthTransport(this.config, provider));
        } catch (err) {
          // A streamable-HTTP endpoint that is really SSE tends to fail the
          // handshake (405/404). Retry once on the other transport before
          // giving up — unless it was an auth failure, which SSE won't fix.
          if (
            this.config.transport === 'http' &&
            !isAuthError(err) &&
            this.config.url.endsWith('/sse') === false
          ) {
            await this.attempt(client, buildAuthTransport({ ...this.config, transport: 'sse' }, provider));
          } else {
            throw err;
          }
        }
      }
      this.client = client;
      this._state = 'ready';
    } catch (err) {
      this._state = 'failed';
      this._error = isAuthError(err)
        ? `needs authorization — run: hc mcp login ${this.name}`
        : err instanceof Error
          ? err.message
          : String(err);
      try {
        await client.close();
      } catch {
        // best effort
      }
    }
  }

  private stdioTransport(config: Extract<McpServerConfig, { transport: 'stdio' }>): StdioClientTransport {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...pickInheritedEnv(), ...config.env },
      stderr: 'ignore',
    });
  }

  private attempt(client: Client, transport: Transport): Promise<void> {
    return withTimeout(
      client.connect(transport),
      this.connectTimeoutMs,
      `MCP server "${this.name}" did not respond within ${this.connectTimeoutMs}ms`,
    );
  }

  private async ready(): Promise<Client | undefined> {
    await this.ensureConnected();
    return this._state === 'ready' ? this.client : undefined;
  }

  async listTools(): Promise<McpTool[]> {
    const client = await this.ready();
    if (!client) return [];
    try {
      const res = await client.listTools();
      return res.tools.map((t) => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
      }));
    } catch (err) {
      this.markDegraded(err);
      return [];
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    const client = await this.ready();
    if (!client) {
      return { text: `MCP server "${this.name}" is unavailable: ${this._error ?? 'not connected'}`, isError: true };
    }
    const res = (await client.callTool({ name, arguments: args })) as {
      content?: unknown[];
      isError?: boolean;
    };
    return { text: flattenContent(res.content), isError: res.isError === true };
  }

  async listResources(): Promise<McpResource[]> {
    const client = await this.ready();
    if (!client) return [];
    try {
      const res = await client.listResources();
      return res.resources as McpResource[];
    } catch {
      return [];
    }
  }

  async readResource(uri: string): Promise<string> {
    const client = await this.ready();
    if (!client) throw new Error(`MCP server "${this.name}" is unavailable: ${this._error ?? 'not connected'}`);
    const res = (await client.readResource({ uri })) as {
      contents?: { text?: string; blob?: string; uri?: string }[];
    };
    return (res.contents ?? [])
      .map((c) => c.text ?? (c.blob ? `[binary resource ${c.uri ?? uri}]` : ''))
      .filter(Boolean)
      .join('\n');
  }

  async listPrompts(): Promise<McpPrompt[]> {
    const client = await this.ready();
    if (!client) return [];
    try {
      const res = await client.listPrompts();
      return res.prompts as McpPrompt[];
    } catch {
      return [];
    }
  }

  async getPrompt(name: string, args: Record<string, string> = {}): Promise<string> {
    const client = await this.ready();
    if (!client) throw new Error(`MCP server "${this.name}" is unavailable: ${this._error ?? 'not connected'}`);
    const res = (await client.getPrompt({ name, arguments: args })) as {
      messages?: { role: string; content: unknown }[];
    };
    return (res.messages ?? [])
      .map((m) => `${m.role}: ${flattenContent([m.content])}`)
      .join('\n');
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // best effort
      }
    }
    this.client = undefined;
    if (this._state !== 'failed') this._state = 'idle';
    this.connectPromise = undefined;
  }

  private markDegraded(err: unknown): void {
    this._state = 'failed';
    this._error = err instanceof Error ? err.message : String(err);
  }
}

function isAuthError(err: unknown): boolean {
  if (err instanceof UnauthorizedError || err instanceof OAuthNeedsLoginError) return true;
  // SseError / StreamableHTTPError carry the HTTP status as `code`.
  const code = (err as { code?: unknown } | null)?.code;
  return code === 401 || code === 403;
}

function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'resource' && b.resource && typeof b.resource === 'object') {
      const r = b.resource as Record<string, unknown>;
      if (typeof r.text === 'string') parts.push(r.text);
      else if (typeof r.uri === 'string') parts.push(`[resource ${r.uri}]`);
    } else if (b.type === 'image') parts.push('[image]');
    else if (typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

/** Whitelist a few env vars a spawned server almost always needs (PATH, HOME…). */
function pickInheritedEnv(): Record<string, string> {
  const keys = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'PATHEXT', 'SYSTEMROOT', 'APPDATA'];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
