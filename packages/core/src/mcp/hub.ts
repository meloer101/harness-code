/**
 * The set of MCP servers a run has configured.
 *
 * `toolSpecs()` connects every server (lazily, in parallel) and returns the
 * union of their tools, already namespaced. A server that fails to connect
 * contributes nothing and is reported through `status()` — it never makes the
 * whole call throw, so one broken server in `.mcp.json` cannot take the agent
 * down with it.
 */

import type { AnyToolSpec } from '../tools/types.js';
import { McpConnection } from './client.js';
import type { McpConnectionState, McpPrompt, McpResource } from './client.js';
import type { McpServerConfig } from './config.js';
import { adaptMcpTool } from './tool-adapter.js';

export interface McpServerStatus {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  state: McpConnectionState;
  error?: string;
  toolCount: number;
}

export class McpHub {
  private readonly connections: McpConnection[];
  private readonly transportByName = new Map<string, 'stdio' | 'http' | 'sse'>();
  private toolCache: AnyToolSpec[] | undefined;
  private readonly toolCountByName = new Map<string, number>();

  constructor(configs: readonly McpServerConfig[], opts: { connectTimeoutMs?: number } = {}) {
    this.connections = configs.map((c) => {
      this.transportByName.set(c.name, c.transport);
      return new McpConnection(c, opts);
    });
  }

  get empty(): boolean {
    return this.connections.length === 0;
  }

  /** Every server's tools, connecting on first call and caching the result. */
  async toolSpecs(): Promise<AnyToolSpec[]> {
    if (this.toolCache) return this.toolCache;
    const perServer = await Promise.all(
      this.connections.map(async (conn) => {
        const tools = await conn.listTools();
        this.toolCountByName.set(conn.name, tools.length);
        return tools.map((t) => adaptMcpTool(conn, t));
      }),
    );
    this.toolCache = perServer.flat();
    return this.toolCache;
  }

  async resources(): Promise<{ server: string; resource: McpResource }[]> {
    const perServer = await Promise.all(
      this.connections.map(async (conn) =>
        (await conn.listResources()).map((resource) => ({ server: conn.name, resource })),
      ),
    );
    return perServer.flat();
  }

  async prompts(): Promise<{ server: string; prompt: McpPrompt }[]> {
    const perServer = await Promise.all(
      this.connections.map(async (conn) =>
        (await conn.listPrompts()).map((prompt) => ({ server: conn.name, prompt })),
      ),
    );
    return perServer.flat();
  }

  connection(name: string): McpConnection | undefined {
    return this.connections.find((c) => c.name === name);
  }

  status(): McpServerStatus[] {
    return this.connections.map((c) => ({
      name: c.name,
      transport: this.transportByName.get(c.name) ?? 'stdio',
      state: c.state,
      ...(c.error !== undefined ? { error: c.error } : {}),
      toolCount: this.toolCountByName.get(c.name) ?? 0,
    }));
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.connections.map((c) => c.close()));
    this.toolCache = undefined;
  }
}
