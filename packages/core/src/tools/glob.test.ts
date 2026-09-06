import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionState } from '../agent/session.js';
import { globTool } from './glob.js';
import type { ToolContext } from './types.js';

describe('globTool', () => {
  let cwd: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    // realpath: os.tmpdir() is a symlink on macOS; assertInsideWorkspace()
    // realpaths everything, so `cwd` needs to be canonical too.
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'hc-glob-')));
    ctx = { cwd, session: new SessionState() };
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'a.ts'), '', 'utf8');
    await writeFile(join(cwd, 'src', 'b.ts'), '', 'utf8');
    await writeFile(join(cwd, 'README.md'), '', 'utf8');
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('matches files by glob pattern', async () => {
    const result = await globTool.execute({ pattern: 'src/**/*.ts' }, ctx);
    expect(result.content).toContain('src/a.ts');
    expect(result.content).toContain('src/b.ts');
    expect(result.content).not.toContain('README.md');
  });

  it('reports no matches without erroring', async () => {
    const result = await globTool.execute({ pattern: '**/*.nope' }, ctx);
    expect(result.content).toBe('(no matches)');
  });

  it('refuses to search from a cwd outside the workspace', async () => {
    const result = await globTool.execute({ pattern: '*', cwd: '..' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes the workspace/);
  });
});
