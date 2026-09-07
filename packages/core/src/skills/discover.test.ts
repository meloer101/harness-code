import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverSkills } from './discover.js';

async function writeSkill(
  root: string,
  name: string,
  frontmatter: Record<string, string>,
  body = 'Body.',
): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const fm = ['---', ...Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`), '---', '', body];
  await writeFile(join(dir, 'SKILL.md'), fm.join('\n'), 'utf8');
}

describe('discoverSkills', () => {
  let root: string;
  let home: string;
  let builtin: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'hc-sk-')));
    await mkdir(join(root, '.git'), { recursive: true });
    home = await realpath(await mkdtemp(join(tmpdir(), 'hc-skhome-')));
    builtin = await realpath(await mkdtemp(join(tmpdir(), 'hc-skbuiltin-')));
  });

  afterEach(async () => {
    for (const d of [root, home, builtin]) await rm(d, { recursive: true, force: true });
  });

  const run = () => discoverSkills(root, { homeDir: home, builtinDir: builtin });

  it('returns nothing when no skill directories exist', async () => {
    const { skills } = await run();
    expect(skills).toEqual([]);
  });

  it('discovers skills from project, user, and builtin roots', async () => {
    await writeSkill(join(root, '.agent', 'skills'), 'proj', { name: 'proj', description: 'p' });
    await writeSkill(join(home, '.agent', 'skills'), 'usr', { name: 'usr', description: 'u' });
    await writeSkill(builtin, 'built', { name: 'built', description: 'b' });

    const { skills, counts } = await run();
    expect(skills.map((s) => s.name).sort()).toEqual(['built', 'proj', 'usr']);
    expect(counts).toEqual({ project: 1, user: 1, builtin: 1 });
    expect(skills.find((s) => s.name === 'built')?.source).toBe('builtin');
  });

  it('lets a higher-precedence root shadow the same name', async () => {
    await writeSkill(join(root, '.agent', 'skills'), 'dup', { name: 'dup', description: 'from project' });
    await writeSkill(builtin, 'dup', { name: 'dup', description: 'from builtin' });

    const { skills, counts } = await run();
    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe('from project');
    expect(skills[0]?.source).toBe('project');
    expect(counts.builtin).toBe(0);
  });

  it('skips an invalid skill and keeps the valid ones', async () => {
    await writeSkill(builtin, 'good', { name: 'good', description: 'g' });
    await writeSkill(builtin, 'bad', { name: 'mismatch', description: 'x' });
    await mkdir(join(builtin, 'nofile'), { recursive: true });

    const skipped: string[] = [];
    const { skills } = await discoverSkills(root, {
      homeDir: home,
      builtinDir: builtin,
      onSkip: (r) => skipped.push(r),
    });
    expect(skills.map((s) => s.name)).toEqual(['good']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatch(/bad/);
  });
});
