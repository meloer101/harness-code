/**
 * Assembles an `AgentSessionConfig` from CLI-flag-shaped inputs: load layered
 * settings, resolve the model (and small model) through the provider
 * registry, resolve budgets, then build the config literal.
 *
 * Pulled out of `packages/cli/src/index.ts` so the CLI and the (future) `hc
 * web` server build sessions identically instead of two copies of this
 * assembly drifting apart. Throws a plain `Error` when no model can be
 * resolved — callers decide how to surface that (the CLI turns it into a
 * `process.exit`; a server would turn it into an RPC error).
 */

import { resolveBudgets } from '../config/budgets.js';
import { loadSettings } from '../config/settings.js';
import type { PermissionMode } from '../permissions/index.js';
import { ProviderRegistry } from '../provider/router.js';
import type { AgentSessionConfig } from './session-runner.js';

export interface BuildSessionConfigOptions {
  cwd: string;
  /** `provider/model` reference. Falls back to `settings.model` when omitted. */
  modelRef?: string;
  maxTurns?: number;
  maxCost?: number;
  maxTokens?: number;
  mode?: PermissionMode;
  allow?: string[];
  ask?: string[];
  deny?: string[];
  // Subsystem switches — undefined means "let AgentSession apply its own default".
  skills?: boolean;
  subagents?: boolean;
  /** Also feeds `resolveBudgets`' `noCompact` flag (`compact === false`). */
  compact?: boolean;
  mcp?: boolean;
  trace?: boolean;
  /** Continue a previous session by id. */
  resumeId?: string;
}

/** Thrown by `buildSessionConfig` when no model ref is configured anywhere. */
export class NoModelConfiguredError extends Error {
  constructor() {
    super('No model configured. Pass --model, or set "model" in .agent/settings.json.');
    this.name = 'NoModelConfiguredError';
  }
}

export async function buildSessionConfig(
  opts: BuildSessionConfigOptions,
): Promise<AgentSessionConfig> {
  const { settings } = await loadSettings(opts.cwd);
  const ref = opts.modelRef ?? settings.model;
  if (!ref) throw new NoModelConfiguredError();

  const registry = new ProviderRegistry({ settings });
  const resolved = registry.resolve(ref);
  const budgets = resolveBudgets(
    {
      maxTurns: opts.maxTurns,
      maxCost: opts.maxCost,
      maxTokens: opts.maxTokens,
      noCompact: opts.compact === false,
    },
    settings,
  );

  return {
    cwd: opts.cwd,
    model: resolved,
    ...(settings.smallModel ? { summarizerModel: registry.resolve(settings.smallModel) } : {}),
    settings,
    budgets,
    ...(opts.mode ? { mode: opts.mode } : {}),
    allow: opts.allow ?? [],
    ask: opts.ask ?? [],
    deny: opts.deny ?? [],
    skills: opts.skills,
    subagents: opts.subagents,
    compact: opts.compact,
    mcp: opts.mcp,
    trace: opts.trace,
    ...(opts.resumeId ? { resumeId: opts.resumeId } : {}),
  };
}
