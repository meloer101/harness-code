/**
 * `allowed-tools` enforcement — the coarse half.
 *
 * When an active skill declared `allowed-tools`, the tool set offered to the
 * model on the next turn is filtered to the tools it named (multiple active
 * skills intersect). `skill` and `todo` are always kept: the model still needs
 * to load other skills and track its progress.
 *
 * This filters at the "which tools does the model see" layer. It does not do
 * per-call specifier matching (e.g. `Bash(git:*)` letting only `git …` through
 * `bash`) — the permission engine's own rules remain the place for that.
 */

import { parseRule } from '../permissions/parse.js';
import { ruleMatchesMcp } from '../permissions/match.js';
import type { ActiveSkill } from '../agent/control.js';
import type { AnyToolSpec } from '../tools/types.js';

const ALWAYS_KEEP = new Set(['skill', 'todo']);

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

export function narrowToolSpecs(
  specs: readonly AnyToolSpec[],
  activeSkills: readonly ActiveSkill[],
): AnyToolSpec[] {
  const constraints = activeSkills
    .map((s) => s.allowedTools)
    .filter((r): r is string[] => r !== undefined && r.length > 0);
  if (constraints.length === 0) return [...specs];

  return specs.filter(
    (spec) =>
      ALWAYS_KEEP.has(spec.name.toLowerCase()) ||
      constraints.every((rules) => toolAllowed(spec.name, rules)),
  );
}
