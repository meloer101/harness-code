/**
 * Layered settings.
 *
 * Three layers, most specific last: built-in defaults, the user's
 * `~/.agent/settings.json`, then the project's `.agent/settings.json`. A project
 * can point at a different endpoint or model without the user editing globals,
 * and neither file has to exist.
 *
 * This file grows in later phases (permission rules, MCP servers, skill paths).
 * The merge strategy is fixed here so those additions inherit it.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { DEFAULT_ALLOW_RULES } from '../permissions/defaults.js';
import type { PermissionConfig } from '../permissions/types.js';
import type { RouterSettings } from '../provider/router.js';

export interface Settings extends RouterSettings {
  /** `provider/model` used when none is given on the command line. */
  model?: string;
  /** Cheaper model for summarization and other background work. */
  smallModel?: string;
  maxTurns?: number;
  maxCostUSD?: number;
  /** Stop once cumulative input+output tokens exceed this. */
  maxTokens?: number;
  /** Per-request output cap; also the space reserved out of the context window. */
  maxOutputTokens?: number;
  temperature?: number;
  /** Usable-window fraction at which history is auto-compacted. Loop default 0.92. */
  contextCompactRatio?: number;
  /** Trailing turns kept verbatim through a compaction. Compactor default 3. */
  compactKeepTurns?: number;
  permissions?: PermissionConfig;
}

export const DEFAULT_SETTINGS: Settings = {
  model: 'deepseek/deepseek-chat',
  maxTurns: 50,
  temperature: 0,
  permissions: {
    mode: 'ask',
    allow: [...DEFAULT_ALLOW_RULES],
    ask: [],
    deny: [],
  },
};

export const AGENT_DIR = '.agent';
export const SETTINGS_FILE = 'settings.json';

export interface LoadedSettings {
  settings: Settings;
  /** Files that were actually read, in application order. For `hc doctor`. */
  sources: string[];
}

export async function loadSettings(cwd = process.cwd()): Promise<LoadedSettings> {
  const candidates = [
    join(homedir(), AGENT_DIR, SETTINGS_FILE),
    join(await findProjectRoot(cwd), AGENT_DIR, SETTINGS_FILE),
  ];

  let settings: Settings = { ...DEFAULT_SETTINGS };
  const sources: string[] = [];

  for (const path of candidates) {
    const layer = await readSettingsFile(path);
    if (!layer) continue;
    settings = mergeSettings(settings, layer);
    sources.push(path);
  }

  return { settings, sources };
}

async function readSettingsFile(path: string): Promise<Settings | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined; // Absent is the normal case, not an error.
  }
  try {
    return JSON.parse(raw) as Settings;
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Shallow for scalars, per-key merge for the two record-shaped fields. Deep
 * merging everything would make it impossible for a project to *replace* a
 * provider definition rather than extend it.
 */
export function mergeSettings(base: Settings, layer: Settings): Settings {
  const merged: Settings = { ...base, ...layer };
  if (base.providers || layer.providers) {
    merged.providers = { ...base.providers };
    for (const [id, cfg] of Object.entries(layer.providers ?? {})) {
      merged.providers[id] = { ...(base.providers?.[id] ?? {}), ...cfg };
    }
  }
  if (base.capabilities || layer.capabilities) {
    merged.capabilities = { ...base.capabilities, ...layer.capabilities };
  }
  if (base.permissions || layer.permissions) {
    merged.permissions = {
      mode: layer.permissions?.mode ?? base.permissions?.mode,
      planApprovedMode: layer.permissions?.planApprovedMode ?? base.permissions?.planApprovedMode,
      allow: [...(base.permissions?.allow ?? []), ...(layer.permissions?.allow ?? [])],
      ask: [...(base.permissions?.ask ?? []), ...(layer.permissions?.ask ?? [])],
      deny: [...(base.permissions?.deny ?? []), ...(layer.permissions?.deny ?? [])],
    };
  }
  return merged;
}

/**
 * Nearest ancestor holding a `.agent` directory or a `.git` directory. Falls
 * back to `cwd`, so the tool works in a directory that is not a repository.
 */
export async function findProjectRoot(cwd = process.cwd()): Promise<string> {
  const { stat } = await import('node:fs/promises');
  let dir = resolve(cwd);

  for (;;) {
    for (const marker of [AGENT_DIR, '.git']) {
      try {
        const s = await stat(join(dir, marker));
        if (s.isDirectory()) return dir;
      } catch {
        // keep looking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}
