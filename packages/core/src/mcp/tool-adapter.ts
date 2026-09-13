/**
 * MCP tool -> harness `ToolSpec`.
 *
 * The name is namespaced `mcp__<server>__<tool>` so it can never collide with a
 * builtin and the permission engine can match rules by server. The MCP server
 * owns the real input contract (a raw JSON Schema), so `schema` here is only a
 * passthrough guard and `rawInputSchema` carries the schema the model sees.
 *
 * `readOnly`/`concurrencySafe` are both false: there is no reliable way to know
 * whether an arbitrary MCP tool mutates state, so it is scheduled serially and
 * treated as write-like by the permission engine (asked in `ask`, refused in
 * `plan`) — the same conservative default `bash` gets.
 */

import { z } from 'zod';

import { truncateHeadTail } from '../context/truncate.js';
import type { JSONSchema } from '../provider/types.js';
import type { AnyToolSpec } from '../tools/types.js';
import type { McpConnection, McpTool } from './client.js';

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/**
 * Ceiling on the text an MCP tool result contributes to context. An MCP server
 * is arbitrary code we don't control, so a chatty tool could otherwise dump
 * unbounded output into the window — the same guard the `bash` tool applies to
 * command output.
 */
const MAX_RESULT_CHARS = 30_000;

const passthrough = z.record(z.string(), z.unknown());

export function adaptMcpTool(connection: McpConnection, tool: McpTool): AnyToolSpec {
  const name = mcpToolName(connection.name, tool.name);
  const description =
    (tool.description ?? `Tool "${tool.name}" from MCP server "${connection.name}".`).trim();

  return {
    name,
    description,
    schema: passthrough as unknown as z.ZodType<unknown>,
    rawInputSchema: normalizeSchema(tool.inputSchema),
    readOnly: false,
    concurrencySafe: false,
    async execute(input, ctx) {
      const args =
        input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      const { text, isError } = await connection.callTool(
        tool.name,
        args,
        ctx.signal ? { signal: ctx.signal } : {},
      );
      const clamped = truncateHeadTail(text, { maxChars: MAX_RESULT_CHARS }).text;
      return { content: clamped || '(no output)', ...(isError ? { isError: true } : {}) };
    },
  };
}

/** MCP guarantees an object schema; fill in the shell if a server omitted it. */
function normalizeSchema(schema: Record<string, unknown>): JSONSchema {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const s = { ...schema } as JSONSchema;
  if (s.type === undefined) s.type = 'object';
  if (s.type === 'object' && s.properties === undefined) s.properties = {};
  return s;
}
