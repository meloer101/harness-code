import { mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionState } from '../agent/session.js';
import { editTool } from './edit.js';
import { readTool } from './read.js';
import type { ToolContext } from './types.js';

describe('editTool', () => {
  let cwd: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    // realpath: os.tmpdir() is a symlink on macOS; assertInsideWorkspace()
    // realpaths everything, so `cwd` needs to be canonical too.
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'hc-edit-')));
    ctx = { cwd, session: new SessionState() };
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('refuses to edit a file that has not been read', async () => {
    await writeFile(join(cwd, 'a.txt'), 'foo bar', 'utf8');
    const result = await editTool.execute(
      { path: 'a.txt', oldString: 'foo', newString: 'baz' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('foo bar');
  });

  it('replaces a unique match after the file has been read', async () => {
    await writeFile(join(cwd, 'a.txt'), 'foo bar', 'utf8');
    await readTool.execute({ path: 'a.txt' }, ctx);
    const result = await editTool.execute(
      { path: 'a.txt', oldString: 'foo', newString: 'baz' },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('baz bar');
  });

  it('rejects an ambiguous match unless replaceAll is set', async () => {
    await writeFile(join(cwd, 'a.txt'), 'foo foo', 'utf8');
    await readTool.execute({ path: 'a.txt' }, ctx);
    const ambiguous = await editTool.execute(
      { path: 'a.txt', oldString: 'foo', newString: 'baz' },
      ctx,
    );
    expect(ambiguous.isError).toBe(true);
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('foo foo');

    const replaced = await editTool.execute(
      { path: 'a.txt', oldString: 'foo', newString: 'baz', replaceAll: true },
      ctx,
    );
    expect(replaced.isError).toBeUndefined();
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('baz baz');
  });

  it('rejects an edit when the file changed on disk since it was read', async () => {
    await writeFile(join(cwd, 'a.txt'), 'foo bar', 'utf8');
    await readTool.execute({ path: 'a.txt' }, ctx);
    // Simulate an external modification: same content, newer mtime.
    await utimes(join(cwd, 'a.txt'), new Date(), new Date(Date.now() + 60_000));

    const result = await editTool.execute(
      { path: 'a.txt', oldString: 'foo', newString: 'baz' },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/read it again/i);
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('foo bar');
  });

  it('allows a second consecutive edit without a re-read', async () => {
    await writeFile(join(cwd, 'a.txt'), 'foo bar baz', 'utf8');
    await readTool.execute({ path: 'a.txt' }, ctx);
    await editTool.execute({ path: 'a.txt', oldString: 'foo', newString: 'FOO' }, ctx);
    const second = await editTool.execute({ path: 'a.txt', oldString: 'baz', newString: 'BAZ' }, ctx);
    expect(second.isError).toBeUndefined();
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('FOO bar BAZ');
  });

  it('reports an error when oldString is not found', async () => {
    await writeFile(join(cwd, 'a.txt'), 'foo bar', 'utf8');
    await readTool.execute({ path: 'a.txt' }, ctx);
    const result = await editTool.execute(
      { path: 'a.txt', oldString: 'nope', newString: 'x' },
      ctx,
    );
    expect(result.isError).toBe(true);
  });
});
