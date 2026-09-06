import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isSensitivePath, resolveInWorkspace } from './paths.js';

describe('resolveInWorkspace', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hc-cage-'));
    outside = await mkdtemp(join(tmpdir(), 'hc-cage-out-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'ok', 'utf8');
    await writeFile(join(outside, 'secret.txt'), 'nope', 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('allows a path inside the workspace', async () => {
    const resolved = await resolveInWorkspace(root, 'src/a.ts');
    expect(resolved).toBe(join(await realpath(root), 'src', 'a.ts'));
  });

  it('rejects ../ traversal', async () => {
    await expect(resolveInWorkspace(root, '../secret.txt')).rejects.toThrow(/escapes the workspace/);
  });

  it('rejects a symlink that points outside the workspace', async () => {
    const link = join(root, 'escape');
    await symlink(outside, link);
    await expect(resolveInWorkspace(root, 'escape/secret.txt')).rejects.toThrow(
      /escapes the workspace/,
    );
  });

  it('rejects an absolute path outside the workspace', async () => {
    await expect(resolveInWorkspace(root, '/etc/passwd')).rejects.toThrow(/escapes the workspace/);
  });

  it('rejects creating a file via workspace/../outside', async () => {
    await expect(resolveInWorkspace(root, '../nope.txt')).rejects.toThrow(/escapes the workspace/);
  });
});

describe('isSensitivePath', () => {
  it('flags env files, git config, keys, pems, and credentials', () => {
    expect(isSensitivePath('.env')).toBe(true);
    expect(isSensitivePath('.env.local')).toBe(true);
    expect(isSensitivePath('.git/config')).toBe(true);
    expect(isSensitivePath('id_rsa')).toBe(true);
    expect(isSensitivePath('certs/foo.pem')).toBe(true);
    expect(isSensitivePath('credentials.json')).toBe(true);
    expect(isSensitivePath('src/a.ts')).toBe(false);
  });
});
