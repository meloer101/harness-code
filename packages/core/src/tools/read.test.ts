import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionState } from '../agent/session.js';
import { readTool } from './read.js';
import type { ToolContext } from './types.js';

describe('readTool', () => {
  let cwd: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    // realpath: on macOS, os.tmpdir() is itself a symlink, and
    // assertInsideWorkspace() realpaths everything it resolves — so `cwd` has
    // to be canonical too, or a raw `join(cwd, ...)` won't string-match what
    // the tool records into the session.
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'hc-read-')));
    ctx = { cwd, session: new SessionState() };
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(cwd, { recursive: true, force: true });
  });

  it('numbers lines like cat -n and records the read', async () => {
    await writeFile(join(cwd, 'a.txt'), 'one\ntwo\nthree', 'utf8');
    const result = await readTool.execute({ path: 'a.txt' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('1\tone');
    expect(result.content).toContain('3\tthree');
    expect(ctx.session.hasRead(join(cwd, 'a.txt'))).toBe(true);
  });

  it('paginates with offset/limit and reports what was omitted', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    await writeFile(join(cwd, 'b.txt'), lines, 'utf8');
    const result = await readTool.execute({ path: 'b.txt', offset: 3, limit: 2 }, ctx);
    expect(result.content).toContain('3\tline3');
    expect(result.content).toContain('4\tline4');
    expect(result.content).not.toContain('line5');
    expect(result.content).toMatch(/more line\(s\); pass offset 5/);
  });

  it('reports an error for a missing file instead of throwing', async () => {
    const result = await readTool.execute({ path: 'missing.txt' }, ctx);
    expect(result.isError).toBe(true);
  });

  it('refuses to read a path outside the workspace', async () => {
    const result = await readTool.execute({ path: '../secret' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes the workspace/);
  });

  it('clamps a single very long line instead of dumping it whole', async () => {
    await writeFile(join(cwd, 'min.js'), `${'x'.repeat(500_000)}\nshort line`, 'utf8');
    const result = await readTool.execute({ path: 'min.js' }, ctx);
    expect(result.content.length).toBeLessThan(10_000);
    expect(result.content).toMatch(/\+\d+ chars on this line/);
    expect(result.content).toContain('short line');
  });
});
