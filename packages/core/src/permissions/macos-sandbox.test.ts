import { describe, expect, it } from 'vitest';

import { buildSandboxProfile, wrapCommand } from './macos-sandbox.js';

describe('buildSandboxProfile', () => {
  it('denies file-write everywhere and re-allows it under the workspace', () => {
    const profile = buildSandboxProfile('/Users/m/project');
    expect(profile).toContain('(deny file-write* (subpath "/"))');
    expect(profile).toContain('(allow file-write* (subpath "/Users/m/project"))');
  });

  it('leaves reads, network, and process-exec at the default allow', () => {
    const profile = buildSandboxProfile('/Users/m/project');
    expect(profile).toContain('(allow default)');
    expect(profile).not.toMatch(/deny\s+file-read/);
    expect(profile).not.toMatch(/deny\s+network/);
    expect(profile).not.toMatch(/deny\s+process-exec/);
  });

  it('also allows writes under any extra writable paths given', () => {
    const profile = buildSandboxProfile('/Users/m/project', ['/tmp']);
    expect(profile).toContain('(allow file-write* (subpath "/tmp"))');
  });

  it('escapes double quotes and backslashes in paths', () => {
    const profile = buildSandboxProfile('/Users/m/weird "path"');
    expect(profile).toContain('(allow file-write* (subpath "/Users/m/weird \\"path\\""))');
  });
});

describe('wrapCommand', () => {
  it('leaves the command unwrapped when sandboxing is unavailable', () => {
    const result = wrapCommand(['-c', 'echo hi'], '/workspace', false);
    expect(result).toEqual({ cmd: '/bin/sh', args: ['-c', 'echo hi'] });
  });

  it('wraps with sandbox-exec and an inline profile when available', () => {
    const result = wrapCommand(['-c', 'echo hi'], '/workspace', true);
    expect(result.cmd).toBe('/usr/bin/sandbox-exec');
    expect(result.args[0]).toBe('-p');
    expect(result.args[1]).toContain('/workspace');
    expect(result.args.slice(2)).toEqual(['/bin/sh', '-c', 'echo hi']);
  });
});
