import { mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionState } from '../agent/session.js';
import { readTool } from './read.js';
import type { ToolContext } from './types.js';
import { writeTool } from './write.js';

describe('writeTool', () => {
  let cwd: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    // realpath: os.tmpdir() is a symlink on macOS; assertInsideWorkspace()
    // realpaths everything, so `cwd` needs to be canonical too.
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'hc-write-')));
    ctx = { cwd, session: new SessionState() };
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('creates a new file without requiring a prior read', async () => {
    const result = await writeTool.execute({ path: 'new.txt', content: 'hello' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(await readFile(join(cwd, 'new.txt'), 'utf8')).toBe('hello');
  });

  it('refuses to overwrite an existing file that was not read first', async () => {
    await writeFile(join(cwd, 'existing.txt'), 'original', 'utf8');
    const result = await writeTool.execute({ path: 'existing.txt', content: 'clobbered' }, ctx);
    expect(result.isError).toBe(true);
    expect(await readFile(join(cwd, 'existing.txt'), 'utf8')).toBe('original');
  });

  it('allows overwriting once the file has been read', async () => {
    await writeFile(join(cwd, 'existing.txt'), 'original', 'utf8');
    await readTool.execute({ path: 'existing.txt' }, ctx);
    const result = await writeTool.execute({ path: 'existing.txt', content: 'updated' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(await readFile(join(cwd, 'existing.txt'), 'utf8')).toBe('updated');
  });

  it('rejects overwriting a file that changed on disk since it was read', async () => {
    await writeFile(join(cwd, 'existing.txt'), 'original', 'utf8');
    await readTool.execute({ path: 'existing.txt' }, ctx);
    await utimes(join(cwd, 'existing.txt'), new Date(), new Date(Date.now() + 60_000));

    const result = await writeTool.execute({ path: 'existing.txt', content: 'updated' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/read it again/i);
    expect(await readFile(join(cwd, 'existing.txt'), 'utf8')).toBe('original');
  });

  it('refuses to write outside the workspace', async () => {
    const result = await writeTool.execute({ path: '../pwned.txt', content: 'nope' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes the workspace/);
  });
});
