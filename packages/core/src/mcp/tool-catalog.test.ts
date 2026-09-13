import { describe, expect, it } from 'vitest';

import type { AnyToolSpec } from '../tools/types.js';
import { McpToolCatalog, mcpServerOf, schemaTokens } from './tool-catalog.js';

/** A synthetic MCP tool with a schema of roughly `props` properties. */
function mcpSpec(server: string, tool: string, props = 4): AnyToolSpec {
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < props; i++) {
    properties[`param_${i}`] = {
      type: 'string',
      description: `Parameter ${i} of ${tool}: a reasonably descriptive sentence about it.`,
    };
  }
  return {
    name: `mcp__${server}__${tool}`,
    description: `The ${tool} tool from ${server}. Use it when you need to ${tool.replace(/_/g, ' ')}.`,
    rawInputSchema: { type: 'object', properties, required: Object.keys(properties).slice(0, 2) },
    readOnly: false,
    concurrencySafe: false,
    schema: undefined as never,
    execute: (async () => ({ content: '' })) as never,
  } as AnyToolSpec;
}

function server(name: string, n: number, props = 4): AnyToolSpec[] {
  return Array.from({ length: n }, (_, i) => mcpSpec(name, `op_${i}`, props));
}

describe('mcpServerOf', () => {
  it('parses the server segment, including names with underscores/hyphens', () => {
    expect(mcpServerOf('mcp__github__create_issue')).toBe('github');
    expect(mcpServerOf('mcp__ccd_session__mark_chapter')).toBe('ccd_session');
    expect(mcpServerOf('mcp__a1b2-c3d4__do_thing')).toBe('a1b2-c3d4');
    expect(mcpServerOf('read')).toBeUndefined();
  });
});

describe('McpToolCatalog partition', () => {
  it('keeps a single small server fully inline (no round-trip in the common case)', () => {
    const specs = server('linear', 6);
    const cat = new McpToolCatalog(specs);
    expect(cat.inline).toHaveLength(6);
    expect(cat.deferred).toHaveLength(0);
    expect(cat.manifest()).toBeUndefined();
  });

  it('defers a server with more tools than inlineServerMaxTools', () => {
    const specs = server('huge', 40);
    const cat = new McpToolCatalog(specs, { inlineServerMaxTools: 10 });
    expect(cat.inline).toHaveLength(0);
    expect(cat.deferred).toHaveLength(40);
    expect(cat.manifest()).toContain('<available_mcp_tools>');
    expect(cat.manifest()).toContain('mcp__huge__op_0');
  });

  it('inlines small servers up to the token budget, defers the rest', () => {
    const specs = [...server('a', 4), ...server('b', 4), ...server('c', 4), ...server('d', 4)];
    // A tight budget so only the first server or two fit.
    const cat = new McpToolCatalog(specs, { maxInlineTokens: schemaTokens(specs[0]!) * 6 });
    expect(cat.inline.length).toBeGreaterThan(0);
    expect(cat.deferred.length).toBeGreaterThan(0);
    expect(cat.inline.length + cat.deferred.length).toBe(16);
    // a deferred tool is still resolvable by exact name (for the load tool)
    expect(cat.get(cat.deferred[0]!.name)).toBeDefined();
  });
});

describe('McpToolCatalog measurement (spike finding)', () => {
  it('a heavy multi-server setup costs far fewer per-turn tokens under hybrid disclosure', () => {
    // Representative "power user" setup: a couple of small servers + several big ones.
    const specs = [
      ...server('linear', 6),
      ...server('slack', 8),
      ...server('github', 30),
      ...server('notion', 40),
      ...server('gmail', 25),
      ...server('calendar', 12),
    ];
    const cat = new McpToolCatalog(specs);

    const baseline = McpToolCatalog.allInlineTokens(specs); // today: everything inline
    const hybrid = cat.inlineTokens() + cat.manifestTokens(); // inline small + deferred manifest

    // eslint-disable-next-line no-console
    console.log(
      `[phase4 spike] ${specs.length} MCP tools across 6 servers:\n` +
        `  all-inline (today): ${baseline} tok\n` +
        `  hybrid: ${hybrid} tok (${cat.inline.length} inline, ${cat.deferred.length} deferred, ` +
        `manifest ${cat.manifestTokens()} tok)\n` +
        `  saved: ${baseline - hybrid} tok (${Math.round((1 - hybrid / baseline) * 100)}%)`,
    );

    expect(hybrid).toBeLessThan(baseline);
    // The deferred manifest is a fraction of the schemas it replaces.
    expect(cat.manifestTokens()).toBeLessThan(
      McpToolCatalog.allInlineTokens(cat.deferred),
    );
  });
});
