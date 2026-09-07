/**
 * The reverse direction: expose the builtin tool set as an MCP server, so
 * another agent (or the official inspector) can drive `read`/`grep`/`edit`/…
 * over MCP. The tool schemas are already the source of truth — this is a thin
 * bridge from `ToolSpec` to MCP's tool handlers.
 *
 * Permissions are deliberately NOT applied here: `hc mcp serve` hands the raw
 * tools to whatever connects, exactly like running the binaries directly would.
 * The connecting agent owns its own gating.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { SessionState } from '../agent/session.js';
import type { AnyToolSpec } from '../tools/types.js';
import { toolDefinition } from '../tools/types.js';
import { VERSION } from '../version.js';

export interface HarnessMcpServerOptions {
  tools: readonly AnyToolSpec[];
  cwd?: string;
}

export function createHarnessMcpServer(opts: HarnessMcpServerOptions): Server {
  const cwd = opts.cwd ?? process.cwd();
  const session = new SessionState();
  const byName = new Map(opts.tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: 'harness-code', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: opts.tools.map((spec) => {
      const def = toolDefinition(spec);
      return { name: def.name, description: def.description, inputSchema: def.inputSchema };
    }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const spec = byName.get(req.params.name);
    if (!spec) {
      return { content: [{ type: 'text', text: `Unknown tool "${req.params.name}"` }], isError: true };
    }
    const parsed = spec.schema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return {
        content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }],
        isError: true,
      };
    }
    try {
      const result = await spec.execute(parsed.data, { cwd, session });
      return {
        content: [{ type: 'text', text: result.content }],
        ...(result.isError ? { isError: true } : {}),
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  });

  return server;
}

export async function serveOverStdio(opts: HarnessMcpServerOptions): Promise<void> {
  const server = createHarnessMcpServer(opts);
  await server.connect(new StdioServerTransport());
}
