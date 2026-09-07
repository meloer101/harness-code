import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverAgents } from './discover.js';

async function writeAgent(
  dir: string,
  stem: string,
  fields: Record<string, string>,
  body = 'Do the thing.',
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const fm = ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', '', body];
  await writeFile(join(dir, `${stem}.md`), fm.join('\n'), 'utf8');
}

describe('discoverAgents', () => {
  let root: string;
  let home: string;
  let builtin: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'hc-ag-')));
    await mkdir(join(root, '.git'), { recursive: true });
    home = await realpath(await mkdtemp(join(tmpdir(), 'hc-aghome-')));
    builtin = await realpath(await mkdtemp(join(tmpdir(), 'hc-agbuiltin-')));
  });

  afterEach(async () => {
    for (const d of [root, home, builtin]) await rm(d, { recursive: true, force: true });
  });

  const run = () => discoverAgents(root, { homeDir: home, builtinDir: builtin });

  it('returns nothing when no agent directories exist', async () => {
    expect((await run()).agents).toEqual([]);
  });

  it('discovers from project, user, and builtin, and counts per source', async () => {
    await writeAgent(join(root, '.agent', 'agents'), 'p', { name: 'p', description: 'x' });
    await writeAgent(join(home, '.agent', 'agents'), 'u', { name: 'u', description: 'x' });
    await writeAgent(builtin, 'b', { name: 'b', description: 'x', tools: 'read grep' });

    const { agents, counts } = await run();
    expect(agents.map((a) => a.name).sort()).toEqual(['b', 'p', 'u']);
    expect(counts).toEqual({ project: 1, user: 1, builtin: 1 });
    expect(agents.find((a) => a.name === 'b')?.tools).toEqual(['read', 'grep']);
  });

  it('lets project shadow a builtin of the same name', async () => {
    await writeAgent(join(root, '.agent', 'agents'), 'dup', { name: 'dup', description: 'project one' });
    await writeAgent(builtin, 'dup', { name: 'dup', description: 'builtin one' });
    const { agents } = await run();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.description).toBe('project one');
  });

  it('skips an invalid definition and keeps the rest', async () => {
    await writeAgent(builtin, 'good', { name: 'good', description: 'g' });
    await writeAgent(builtin, 'bad', { name: 'wrong-name', description: 'x' });
    const skipped: string[] = [];
    const { agents } = await discoverAgents(root, {
      homeDir: home,
      builtinDir: builtin,
      onSkip: (r) => skipped.push(r),
    });
    expect(agents.map((a) => a.name)).toEqual(['good']);
    expect(skipped[0]).toMatch(/bad/);
  });
});
