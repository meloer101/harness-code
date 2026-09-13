import { describe, expect, it } from 'vitest';

import type { ToolContext } from '../tools/types.js';
import type { McpConnection, McpTool } from './client.js';
import { adaptMcpTool } from './tool-adapter.js';

const tool: McpTool = { name: 'do', description: 'does', inputSchema: { type: 'object' } };

/** A stub connection that returns whatever text it's constructed with. */
function conn(text: string, isError = false): McpConnection {
  return {
    name: 'srv',
    callTool: async () => ({ text, isError }),
  } as unknown as McpConnection;
}

const ctx = {} as ToolContext;

describe('adaptMcpTool', () => {
  it('namespaces the tool and passes small output through unchanged', async () => {
    const spec = adaptMcpTool(conn('hi'), tool);
    expect(spec.name).toBe('mcp__srv__do');
    const res = await spec.execute({}, ctx);
    expect(res.content).toBe('hi');
    expect(res.isError).toBeUndefined();
  });

  it('substitutes a placeholder for empty output', async () => {
    const res = await adaptMcpTool(conn(''), tool).execute({}, ctx);
    expect(res.content).toBe('(no output)');
  });

  it('propagates an MCP-level error result', async () => {
    const res = await adaptMcpTool(conn('boom', true), tool).execute({}, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toBe('boom');
  });

  it('clamps oversized output with an elision note', async () => {
    const huge = 'x'.repeat(200_000);
    const res = await adaptMcpTool(conn(huge), tool).execute({}, ctx);
    expect(res.content.length).toBeLessThan(huge.length);
    expect(res.content).toMatch(/characters .*omitted/);
  });
});
