import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { McpServerConfig } from './config.js';
import { McpHub } from './hub.js';

const ECHO_SERVER = fileURLToPath(new URL('./__fixtures__/echo-server.mjs', import.meta.url));
const HANG_SERVER = fileURLToPath(new URL('./__fixtures__/hang-server.mjs', import.meta.url));

function stdio(name: string, args: string[]): McpServerConfig {
  return { name, transport: 'stdio', command: process.execPath, args, env: {} };
}

describe('McpHub', () => {
  it('namespaces tools and round-trips a call', async () => {
    const hub = new McpHub([stdio('echo', [ECHO_SERVER])]);
    try {
      const specs = await hub.toolSpecs();
      const echo = specs.find((s) => s.name === 'mcp__echo__echo');
      expect(echo).toBeDefined();
      // schema the model sees is the server's raw JSON Schema, not a zod dump
      expect(echo?.rawInputSchema).toMatchObject({
        type: 'object',
        required: ['message'],
      });
      expect(echo?.readOnly).toBe(false);

      const result = await echo!.execute({ message: 'hi' }, {} as never);
      expect(result.content).toBe('echo: hi');
      expect(result.isError).toBeUndefined();

      expect(hub.status()[0]).toMatchObject({ name: 'echo', state: 'ready', toolCount: 1 });
    } finally {
      await hub.closeAll();
    }
  });

  it('isolates a failed server — the rest still work', async () => {
    const hub = new McpHub([
      stdio('broken', ['-e', 'process.exit(1)']),
      stdio('echo', [ECHO_SERVER]),
    ]);
    try {
      const specs = await hub.toolSpecs();
      expect(specs.map((s) => s.name)).toEqual(['mcp__echo__echo']);

      const status = hub.status();
      expect(status.find((s) => s.name === 'broken')?.state).toBe('failed');
      expect(status.find((s) => s.name === 'echo')?.state).toBe('ready');
    } finally {
      await hub.closeAll();
    }
  });

  it('surfaces resources and prompts', async () => {
    const hub = new McpHub([stdio('echo', [ECHO_SERVER])]);
    try {
      const resources = await hub.resources();
      expect(resources).toEqual([
        expect.objectContaining({ server: 'echo', resource: expect.objectContaining({ uri: 'echo://greeting' }) }),
      ]);
      const prompts = await hub.prompts();
      expect(prompts[0]).toMatchObject({ server: 'echo', prompt: { name: 'summarize' } });
    } finally {
      await hub.closeAll();
    }
  });

  it('a connect timeout does not throw', async () => {
    // A server that never speaks MCP: `cat` sits reading stdin forever.
    const hub = new McpHub([stdio('mute', ['-e', 'setInterval(() => {}, 1000)'])], {
      connectTimeoutMs: 200,
    });
    try {
      const specs = await hub.toolSpecs();
      expect(specs).toEqual([]);
      expect(hub.status()[0]).toMatchObject({ name: 'mute', state: 'failed' });
    } finally {
      await hub.closeAll();
    }
  });

  it('a hung tool call fails within callTimeoutMs, leaving the server ready', async () => {
    const hub = new McpHub([stdio('hang', [HANG_SERVER])], { callTimeoutMs: 200 });
    try {
      const hang = (await hub.toolSpecs()).find((s) => s.name === 'mcp__hang__hang');
      expect(hang).toBeDefined();

      const result = await hang!.execute({}, {} as never);
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/failed/i);
      // one slow tool is not a dead server — the connection stays ready
      expect(hub.status()[0]).toMatchObject({ name: 'hang', state: 'ready' });
    } finally {
      await hub.closeAll();
    }
  });

  it('aborting the signal cancels an in-flight tool call', async () => {
    // A long call timeout, so it is the abort — not the timeout — that ends the call.
    const hub = new McpHub([stdio('hang', [HANG_SERVER])], { callTimeoutMs: 30_000 });
    try {
      const hang = (await hub.toolSpecs()).find((s) => s.name === 'mcp__hang__hang')!;
      const controller = new AbortController();
      const pending = hang.execute({}, { signal: controller.signal } as never);
      controller.abort();
      const result = await pending;
      expect(result.isError).toBe(true);
    } finally {
      await hub.closeAll();
    }
  });
});
