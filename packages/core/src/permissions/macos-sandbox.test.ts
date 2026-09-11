import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { buildSandboxProfile, wrapCommand } from './macos-sandbox.js';

describe('buildSandboxProfile', () => {
  it('keeps harmless device writes open (git opens /dev/null read-write)', () => {
    const profile = buildSandboxProfile('/Users/m/project');
    expect(profile).toContain('(literal "/dev/null")');
    expect(profile).toContain('(regex #"^/dev/fd/")');
  });

  it.runIf(process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'))(
    'lets a real sandboxed shell write /dev/null but not outside the workspace',
    () => {
      const profile = buildSandboxProfile(tmpdir());
      const run = (cmd: string) =>
        spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', cmd], { encoding: 'utf8' });
      expect(run('echo hi > /dev/null && echo ok').stdout.trim()).toBe('ok');
      expect(run('touch /usr/local/hc-sandbox-probe 2>/dev/null || echo denied').stdout.trim()).toBe('denied');
    },
  );

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
