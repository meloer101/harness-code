/**
 * `allowed-tools` enforcement — the coarse half.
 *
 * When an active skill declared `allowed-tools`, the *decoding constraint* and
 * the execute-time gate shrink to those tools (multiple active skills
 * intersect). The tool *schema* array offered to the model stays byte-stable
 * so a mid-session skill load does not punch the prompt cache. `skill`,
 * `todo`, and `memory` are always kept: the model still needs to load other
 * skills, track its progress, and record standing notes.
 *
 * This does not do per-call specifier matching (e.g. `Bash(git:*)` letting
 * only `git …` through `bash`) — the permission engine's own rules remain
 * the place for that.
 */

import { parseRule } from '../permissions/parse.js';
import { ruleMatchesMcp } from '../permissions/match.js';
import type { ActiveSkill } from '../agent/control.js';
import type { AnyToolSpec } from '../tools/types.js';

const ALWAYS_KEEP = new Set(['skill', 'todo', 'memory']);

/** Does `toolName` fall under any of the `allowed-tools` rule strings? */
function toolAllowed(toolName: string, rules: readonly string[]): boolean {
  const name = toolName.toLowerCase();
  for (const raw of rules) {
    let rule;
    try {
      rule = parseRule(raw);
    } catch {
      continue; // a malformed allowed-tools entry just doesn't match anything
    }
    if (name.startsWith('mcp__')) {
      if (ruleMatchesMcp(rule, name)) return true;
    } else if (rule.tool === name) {
      return true;
    }
  }
  return false;
}

/**
 * Names the model may call under the active skills' `allowed-tools`.
 * `undefined` means no constraint — every registered tool is fair game.
 */
export function allowedToolNames(
  specs: readonly AnyToolSpec[],
  activeSkills: readonly ActiveSkill[] | undefined,
): string[] | undefined {
  const constraints = (activeSkills ?? [])
    .map((s) => s.allowedTools)
    .filter((r): r is string[] => r !== undefined && r.length > 0);
  if (constraints.length === 0) return undefined;

  return specs
    .filter(
      (spec) =>
        ALWAYS_KEEP.has(spec.name.toLowerCase()) ||
        constraints.every((rules) => toolAllowed(spec.name, rules)),
    )
    .map((spec) => spec.name);
}

/**
 * @deprecated Filter the registry only in tests / callers that still need a
 * reduced spec list. Production keeps the full tool array and constrains via
 * `allowedToolNames` + an execute-time gate (see AgentLoop).
 */
export function narrowToolSpecs(
  specs: readonly AnyToolSpec[],
  activeSkills: readonly ActiveSkill[],
): AnyToolSpec[] {
  const names = allowedToolNames(specs, activeSkills);
  if (!names) return [...specs];
  const keep = new Set(names.map((n) => n.toLowerCase()));
  return specs.filter((spec) => keep.has(spec.name.toLowerCase()));
}
