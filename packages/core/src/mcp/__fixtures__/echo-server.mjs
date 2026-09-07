/**
 * A minimal MCP server over stdio, used by the MCP client tests. One tool
 * (`echo`), one resource, one prompt — enough to exercise namespacing, schema
 * passthrough, resource reads and prompt expansion without touching the network.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'echo-fixture', version: '0.0.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo the message back',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, (req) => {
  if (req.params.name !== 'echo') {
    return { content: [{ type: 'text', text: `no such tool ${req.params.name}` }], isError: true };
  }
  const message = String(req.params.arguments?.message ?? '');
  return { content: [{ type: 'text', text: `echo: ${message}` }] };
});

server.setRequestHandler(ListResourcesRequestSchema, () => ({
  resources: [{ uri: 'echo://greeting', name: 'greeting', mimeType: 'text/plain' }],
}));

server.setRequestHandler(ReadResourceRequestSchema, (req) => ({
  contents: [{ uri: req.params.uri, mimeType: 'text/plain', text: 'hello from the fixture' }],
}));

server.setRequestHandler(ListPromptsRequestSchema, () => ({
  prompts: [
    {
      name: 'summarize',
      description: 'Ask for a summary',
      arguments: [{ name: 'input', description: 'what to summarize', required: false }],
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, (req) => ({
  messages: [
    {
      role: 'user',
      content: { type: 'text', text: `Summarize: ${req.params.arguments?.input ?? '(nothing)'}` },
    },
  ],
}));

await server.connect(new StdioServerTransport());
