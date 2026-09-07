import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { grepWithJs } from './grep.js';

// Exercises the JS fallback directly, so the test is deterministic regardless
// of whether `rg` happens to be installed on the machine running it.
describe('grepWithJs', () => {
  let cwd: string;

  beforeEach(async () => {
    // realpath: os.tmpdir() is a symlink on macOS; assertInsideWorkspace()
    // realpaths everything, so `cwd` needs to be canonical too.
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'hc-grep-')));
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'a.ts'), 'function add(a, b) {\n  return a + b;\n}\n', 'utf8');
    await writeFile(join(cwd, 'src', 'b.ts'), 'export const noop = () => {};\n', 'utf8');
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('finds matching lines with their line numbers', async () => {
    const result = await grepWithJs({ pattern: 'return a \\+ b' }, cwd);
    expect(result.content).toContain('a.ts:2:');
    expect(result.content).not.toContain('b.ts');
  });

  it('is case-insensitive when asked', async () => {
    const result = await grepWithJs({ pattern: 'FUNCTION', ignoreCase: true }, cwd);
    expect(result.content).toContain('a.ts:1:');
  });

  it('respects a glob restriction', async () => {
    const result = await grepWithJs({ pattern: 'export', glob: 'src/a.ts' }, cwd);
    expect(result.content).toBe('(no matches)');
  });

  it('reports a clear error for an invalid regex', async () => {
    const result = await grepWithJs({ pattern: '(unterminated' }, cwd);
    expect(result.isError).toBe(true);
  });

  it('caps at 200 matches and says how many it showed, not silently', async () => {
    const many = Array.from({ length: 500 }, (_, i) => `hit line ${i}`).join('\n');
    await writeFile(join(cwd, 'src', 'big.ts'), many, 'utf8');

    const result = await grepWithJs({ pattern: 'hit line' }, cwd);

    expect(result.content).toMatch(/showing 200 of at least 200 matches/);
    expect(result.content.split('\n').filter((l) => l.includes('hit line'))).toHaveLength(200);
  });
});
