/**
 * A minimal MCP server over stdio whose one tool (`hang`) accepts the call and
 * then never replies. Used to exercise the client's per-call timeout and the
 * abort-signal path without waiting on a real network stall.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'hang-fixture', version: '0.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [{ name: 'hang', description: 'Never replies', inputSchema: { type: 'object' } }],
}));

// Accept the request and return a promise that never settles.
server.setRequestHandler(CallToolRequestSchema, () => new Promise(() => {}));

await server.connect(new StdioServerTransport());
