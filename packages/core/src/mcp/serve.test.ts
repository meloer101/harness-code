import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { builtinTools } from '../tools/index.js';
import { createHarnessMcpServer } from './serve.js';

describe('createHarnessMcpServer', () => {
  let root: string;
  let client: Client;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hc-serve-'));
    const server = createHarnessMcpServer({ tools: builtinTools(), cwd: root });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await Promise.all([client.connect(a), server.connect(b)]);
  });

  afterEach(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  it('lists the builtin tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['bash', 'edit', 'glob', 'grep', 'read', 'todo', 'write'].sort(),
    );
  });

  it('runs a builtin tool through MCP', async () => {
    await writeFile(join(root, 'hello.txt'), 'from disk\n', 'utf8');
    const res = (await client.callTool({ name: 'read', arguments: { path: 'hello.txt' } })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain('from disk');
  });

  it('shares one session so read-before-edit still holds', async () => {
    await writeFile(join(root, 'a.txt'), 'one\n', 'utf8');
    await client.callTool({ name: 'read', arguments: { path: 'a.txt' } });
    await client.callTool({
      name: 'edit',
      arguments: { path: 'a.txt', oldString: 'one', newString: 'two' },
    });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('two\n');
  });
});
