import { describe, expect, it } from 'vitest';

import { interpolate, parseMcpConfig } from './config.js';

describe('parseMcpConfig', () => {
  it('reads stdio and http servers', () => {
    const servers = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          fs: { command: 'npx', args: ['-y', 'server-filesystem', '.'] },
          api: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer T' } },
        },
      }),
    );
    expect(servers).toEqual([
      { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'server-filesystem', '.'], env: {} },
      { name: 'api', transport: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer T' } },
    ]);
  });

  it('infers http from a bare url', () => {
    const [s] = parseMcpConfig(JSON.stringify({ mcpServers: { a: { url: 'https://y/mcp' } } }));
    expect(s?.transport).toBe('http');
  });

  it('picks the sse transport explicitly or from a /sse url', () => {
    const [a] = parseMcpConfig(JSON.stringify({ mcpServers: { a: { type: 'sse', url: 'https://y/x' } } }));
    expect(a?.transport).toBe('sse');
    const [b] = parseMcpConfig(JSON.stringify({ mcpServers: { b: { url: 'https://mcp.linear.app/sse' } } }));
    expect(b?.transport).toBe('sse');
    const [c] = parseMcpConfig(JSON.stringify({ mcpServers: { c: { type: 'http', url: 'https://y/sse' } } }));
    expect(c?.transport).toBe('http');
  });

  it('parses the auth field and rejects bad values', () => {
    const [a] = parseMcpConfig(JSON.stringify({ mcpServers: { a: { url: 'https://y/mcp', auth: 'none' } } }));
    expect(a).toMatchObject({ auth: 'none' });
    const [b] = parseMcpConfig(JSON.stringify({ mcpServers: { b: { url: 'https://y/mcp', auth: 'oauth' } } }));
    expect(b).toMatchObject({ auth: 'oauth' });
    const [c] = parseMcpConfig(JSON.stringify({ mcpServers: { c: { url: 'https://y/mcp' } } }));
    expect(c).not.toHaveProperty('auth');
    expect(() => parseMcpConfig(JSON.stringify({ mcpServers: { d: { url: 'https://y', auth: 'yes' } } }))).toThrow(/auth/);
  });

  it('substitutes ${ENV} in values', () => {
    const [s] = parseMcpConfig(
      JSON.stringify({ mcpServers: { a: { type: 'http', url: 'https://y', headers: { Authorization: 'Bearer ${TT}' } } } }),
    );
    // interpolate runs against process.env; assert the mechanism directly too
    expect(interpolate('a ${TT} b', { TT: 'x' })).toBe('a x b');
    expect(s?.transport === 'http' && s.headers.Authorization).toContain('Bearer ');
  });

  it('empty / missing mcpServers is not an error', () => {
    expect(parseMcpConfig('{}')).toEqual([]);
    expect(parseMcpConfig(JSON.stringify({ mcpServers: {} }))).toEqual([]);
  });

  it('rejects a server with neither command nor url', () => {
    expect(() => parseMcpConfig(JSON.stringify({ mcpServers: { a: {} } }))).toThrow(/command/);
  });

  it('rejects invalid JSON with the file label', () => {
    expect(() => parseMcpConfig('{ nope', 'proj/.mcp.json')).toThrow(/proj\/\.mcp\.json/);
  });
});
