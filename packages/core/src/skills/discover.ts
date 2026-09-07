/**
 * Skill discovery.
 *
 * Three roots, highest precedence first:
 *   1. `<projectRoot>/.agent/skills/<name>/SKILL.md`   (project)
 *   2. `~/.agent/skills/<name>/SKILL.md`               (user)
 *   3. `<packages/core>/skills/<name>/SKILL.md`         (builtin, ships with hc)
 *
 * A name found in an earlier root shadows the same name in a later one, so a
 * project can override a builtin skill by putting its own next to it. A skill
 * that fails validation is dropped with a one-line note on `onSkip` — never
 * fatal (same posture as a failed MCP server).
 */

import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_DIR, findProjectRoot } from '../config/settings.js';
import type { Skill, SkillSource } from './types.js';
import { parseSkill } from './validate.js';

/** `packages/core/skills/`, resolved relative to this module (works from src and dist alike). */
export function builtinSkillsDir(): string {
  return fileURLToPath(new URL('../../skills/', import.meta.url));
}

export interface DiscoverOptions {
  homeDir?: string;
  /** Where builtin skills live; overridable for tests. */
  builtinDir?: string;
  /** Called once per skipped skill with a human-readable reason. */
  onSkip?: (reason: string) => void;
}

export interface DiscoveredSkills {
  skills: Skill[];
  /** Per-source counts, for the CLI's startup line. */
  counts: Record<SkillSource, number>;
}

export async function discoverSkills(
  cwd = process.cwd(),
  opts: DiscoverOptions = {},
): Promise<DiscoveredSkills> {
  const home = opts.homeDir ?? homedir();
  const root = await findProjectRoot(cwd);
  const roots: { dir: string; source: SkillSource }[] = [
    { dir: join(root, AGENT_DIR, 'skills'), source: 'project' },
    { dir: join(home, AGENT_DIR, 'skills'), source: 'user' },
    { dir: opts.builtinDir ?? builtinSkillsDir(), source: 'builtin' },
  ];

  const byName = new Map<string, Skill>();
  const counts: Record<SkillSource, number> = { project: 0, user: 0, builtin: 0 };

  for (const { dir, source } of roots) {
    let entries: string[];
    try {
      entries = (await readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue; // absent skills directory is the normal case
    }

    for (const dirName of entries.sort()) {
      if (byName.has(dirName)) continue; // shadowed by a higher-precedence root
      const skillDir = join(dir, dirName);
      let raw: string;
      try {
        raw = await readFile(join(skillDir, 'SKILL.md'), 'utf8');
      } catch {
        continue; // a directory without a SKILL.md is not a skill
      }
      const result = parseSkill({ raw, dirName: basename(skillDir), dir: skillDir, source });
      if (!result.ok) {
        opts.onSkip?.(`skill "${dirName}" (${source}): ${result.reason}`);
        continue;
      }
      byName.set(result.skill.name, result.skill);
      counts[source]++;
    }
  }

  return { skills: [...byName.values()], counts };
}
