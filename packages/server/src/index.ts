/**
 * `startServer` — the local `hc web` host: a `node:http` server that serves the
 * SPA bundle and upgrades `/ws` to the RPC + event socket. It binds `127.0.0.1`
 * only and mints a fresh token per start; the token rides the URL fragment so it
 * never lands in logs (docs/web.md, "Security").
 *
 * The public surface is intentionally tiny: `startServer(opts)` →
 * `{ url, token, port, close }`. Everything else (the registry, the WS layer,
 * static serving) is wired here so the CLI and tests share one entry point.
 */

import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import {
  AGENT_DIR,
  ProviderRegistry,
  VERSION,
  buildSessionConfig,
  findProjectRoot,
  loadSettings,
} from '@harness-code/core';
import type { PermissionMode } from '@harness-code/core';
import type { ServerInfo } from '@harness-code/protocol';

import { createStaticHandler, resolveStaticDir } from './http.js';
import { mockConfigFactory } from './mock.js';
import { SessionRegistry } from './registry.js';
import type { SessionConfigFactory } from './registry.js';
import { attachWsServer } from './ws.js';

const PERMISSION_MODES: PermissionMode[] = ['ask', 'plan', 'acceptEdits', 'readOnly', 'yolo'];

export interface StartServerOptions {
  /** Workspace root this server hosts sessions for. */
  cwd: string;
  /** TCP port; `0` (the default) picks a free one. */
  port?: number;
  /** An extra `Origin` to allow through the WS handshake — the Vite dev server. */
  devOrigin?: string;
  /** Default `provider/model` ref for new sessions (overrides `settings.model`). */
  model?: string;
  /** Replace the real model with the scripted `--mock` provider. */
  mock?: boolean;
  /** Inject a session-config factory directly (tests). Wins over `mock`/`model`. */
  buildConfig?: SessionConfigFactory;
  /** Override the static bundle directory (tests / non-standard layouts). */
  staticDir?: string;
}

export interface RunningServer {
  /** `http://127.0.0.1:<port>/#token=<token>` — open this in a browser. */
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
}

export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const { cwd } = opts;
  const projectRoot = await findProjectRoot(cwd);
  const agentDir = join(projectRoot, AGENT_DIR);
  const token = randomBytes(32).toString('hex');

  const buildConfig = resolveConfigFactory(opts);
  const registry = new SessionRegistry({ cwd, agentDir, buildConfig });

  const serverInfo = async (): Promise<ServerInfo> => {
    const { settings } = await loadSettings(cwd);
    const providers = new ProviderRegistry({ settings });
    return {
      version: VERSION,
      cwd,
      projectRoot,
      defaultModel: opts.model ?? settings.model ?? '',
      models: providers.list(),
      modes: PERMISSION_MODES,
    };
  };

  const staticDir = opts.staticDir ?? resolveStaticDir();
  const httpServer = createServer(
    createStaticHandler(staticDir ? { staticDir } : {}),
  );

  const port = await listen(httpServer, opts.port ?? 0);
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  if (opts.devOrigin) origins.add(opts.devOrigin);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const wss = attachWsServer({
    httpServer,
    registry,
    token,
    allowedOrigins: origins,
    allowedHosts: hosts,
    serverInfo,
  });

  const url = `http://127.0.0.1:${port}/#token=${token}`;

  return {
    url,
    token,
    port,
    close: async () => {
      // Terminate live sockets first, otherwise `httpServer.close` waits for
      // every open connection to drain and never resolves.
      for (const client of wss.clients) client.terminate();
      wss.close();
      await registry.shutdown();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/** Pick the session factory: explicit injection > `--mock` > the real config assembly. */
function resolveConfigFactory(opts: StartServerOptions): SessionConfigFactory {
  if (opts.buildConfig) return opts.buildConfig;
  if (opts.mock) return mockConfigFactory(opts.cwd);
  return (o) =>
    buildSessionConfig({
      cwd: opts.cwd,
      ...(o.model ?? opts.model ? { modelRef: o.model ?? opts.model } : {}),
      ...(o.mode ? { mode: o.mode } : {}),
      ...(o.resumeId ? { resumeId: o.resumeId } : {}),
    });
}

/** Bind `127.0.0.1` only and resolve with the actual port (handles `port: 0`). */
function listen(server: HttpServer, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('server address is not a TCP address'));
    });
  });
}

export { SessionRegistry } from './registry.js';
export { SessionHost, BusyError, SessionNotFoundError } from './host.js';
export type { Listener } from './host.js';
export { attachWsServer } from './ws.js';
export type { WsServerOptions } from './ws.js';
export { createStaticHandler, resolveStaticDir } from './http.js';
export { mockConfigFactory } from './mock.js';
export type { SessionConfigFactory, SessionRegistryOptions } from './registry.js';
