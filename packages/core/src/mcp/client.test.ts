import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';

import { buildAuthTransport } from './client.js';
import type { McpHttpServerConfig } from './config.js';

const base: Omit<McpHttpServerConfig, 'transport'> = {
  name: 'x',
  url: 'https://example.com/mcp',
  headers: {},
};

describe('buildAuthTransport', () => {
  it('maps transport kind to the right SDK transport', () => {
    expect(buildAuthTransport({ ...base, transport: 'http' })).toBeInstanceOf(StreamableHTTPClientTransport);
    expect(buildAuthTransport({ ...base, transport: 'sse' })).toBeInstanceOf(SSEClientTransport);
  });
});
