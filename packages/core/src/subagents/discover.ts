/**
 * Sub-agent discovery.
 *
 * Three roots, highest precedence first:
 *   1. `<projectRoot>/.agent/agents/<name>.md`   (project)
 *   2. `~/.agent/agents/<name>.md`               (user)
 *   3. `<packages/core>/agents/<name>.md`        (builtin: explore, plan)
 *
 * Flat `<name>.md` files (not directories — a sub-agent has no bundled
 * resources). Precedence and non-fatal skip mirror `skills/discover.ts`.
 */

import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_DIR, findProjectRoot } from '../config/settings.js';
import type { AgentDefinition, AgentSource } from './types.js';
import { parseAgent } from './validate.js';

/** `packages/core/agents/`, resolved relative to this module (works from src and dist). */
export function builtinAgentsDir(): string {
  return fileURLToPath(new URL('../../agents/', import.meta.url));
}

export interface DiscoverAgentsOptions {
  homeDir?: string;
  builtinDir?: string;
  onSkip?: (reason: string) => void;
}

export interface DiscoveredAgents {
  agents: AgentDefinition[];
  counts: Record<AgentSource, number>;
}

export async function discoverAgents(
  cwd = process.cwd(),
  opts: DiscoverAgentsOptions = {},
): Promise<DiscoveredAgents> {
  const home = opts.homeDir ?? homedir();
  const root = await findProjectRoot(cwd);
  const roots: { dir: string; source: AgentSource }[] = [
    { dir: join(root, AGENT_DIR, 'agents'), source: 'project' },
    { dir: join(home, AGENT_DIR, 'agents'), source: 'user' },
    { dir: opts.builtinDir ?? builtinAgentsDir(), source: 'builtin' },
  ];

  const byName = new Map<string, AgentDefinition>();
  const counts: Record<AgentSource, number> = { project: 0, user: 0, builtin: 0 };

  for (const { dir, source } of roots) {
    let files: string[];
    try {
      files = (await readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => e.name);
    } catch {
      continue;
    }

    for (const file of files.sort()) {
      const stem = basename(file, '.md');
      if (byName.has(stem)) continue; // shadowed by a higher-precedence root
      let raw: string;
      try {
        raw = await readFile(join(dir, file), 'utf8');
      } catch {
        continue;
      }
      const result = parseAgent({ raw, stem, source });
      if (!result.ok) {
        opts.onSkip?.(`agent "${stem}" (${source}): ${result.reason}`);
        continue;
      }
      byName.set(result.agent.name, result.agent);
      counts[source]++;
    }
  }

  return { agents: [...byName.values()], counts };
}
