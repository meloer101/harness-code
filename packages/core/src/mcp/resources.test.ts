import { describe, expect, it } from 'vitest';

import type { McpHub } from './hub.js';
import { findResourceReferences, resolveResources } from './resources.js';

describe('findResourceReferences', () => {
  it('pulls @server:uri tokens out of text, trimming trailing punctuation', () => {
    expect(findResourceReferences('look at @fs:file:///a/b.md and @api:res://x.')).toEqual([
      { server: 'fs', uri: 'file:///a/b.md' },
      { server: 'api', uri: 'res://x' },
    ]);
  });
});

describe('resolveResources', () => {
  const hub = {
    empty: false,
    connection(name: string) {
      if (name !== 'fs') return undefined;
      return { readResource: async (uri: string) => `contents of ${uri}` };
    },
  } as unknown as McpHub;

  it('fetches referenced resources into context blocks', async () => {
    const { context, notes } = await resolveResources(hub, 'summarize @fs:file:///readme');
    expect(context).toEqual(['<resource server="fs" uri="file:///readme">\ncontents of file:///readme\n</resource>']);
    expect(notes[0]).toContain('file:///readme');
  });

  it('notes an unknown server without throwing', async () => {
    const { context, notes } = await resolveResources(hub, '@ghost:res://y');
    expect(context).toEqual([]);
    expect(notes[0]).toContain('no MCP server named "ghost"');
  });
});
