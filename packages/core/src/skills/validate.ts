/**
 * SKILL.md frontmatter validation, straight off the Agent Skills spec.
 *
 * A skill that fails validation is skipped (with a one-line reason), not fatal —
 * one malformed skill in a directory must not take the others down. Same
 * isolation posture as a failed MCP server.
 */

import matter from 'gray-matter';

import type { Skill, SkillSource } from './types.js';

export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 1024;
export const MAX_COMPATIBILITY = 500;

export interface ValidatedSkill {
  ok: true;
  skill: Skill;
}
export interface InvalidSkill {
  ok: false;
  reason: string;
}
export type ValidationResult = ValidatedSkill | InvalidSkill;

interface ParseInput {
  /** Raw SKILL.md text. */
  raw: string;
  /** The skill directory's basename — `name` must match this. */
  dirName: string;
  /** Absolute path of the skill directory. */
  dir: string;
  source: SkillSource;
}

export function parseSkill({ raw, dirName, dir, source }: ParseInput): ValidationResult {
  let data: Record<string, unknown>;
  let body: string;
  try {
    const parsed = matter(raw);
    data = parsed.data as Record<string, unknown>;
    body = parsed.content.trim();
  } catch (err) {
    return { ok: false, reason: `frontmatter is not valid YAML: ${msg(err)}` };
  }

  const name = data.name;
  if (typeof name !== 'string' || name === '') {
    return { ok: false, reason: 'frontmatter is missing a "name"' };
  }
  if (name.length > MAX_NAME || !NAME_RE.test(name)) {
    return {
      ok: false,
      reason: `name "${name}" must be ≤${MAX_NAME} chars, lowercase alphanumeric and single hyphens only`,
    };
  }
  if (name !== dirName) {
    return { ok: false, reason: `name "${name}" does not match its directory "${dirName}"` };
  }

  const description = data.description;
  if (typeof description !== 'string' || description.trim() === '') {
    return { ok: false, reason: 'frontmatter is missing a non-empty "description"' };
  }
  if (description.length > MAX_DESCRIPTION) {
    return { ok: false, reason: `description exceeds ${MAX_DESCRIPTION} characters` };
  }

  const skill: Skill = { name, description: description.trim(), body, dir, source };

  if (typeof data.license === 'string' && data.license.trim() !== '') {
    skill.license = data.license.trim();
  }
  if (typeof data.compatibility === 'string' && data.compatibility.trim() !== '') {
    if (data.compatibility.length > MAX_COMPATIBILITY) {
      return { ok: false, reason: `compatibility exceeds ${MAX_COMPATIBILITY} characters` };
    }
    skill.compatibility = data.compatibility.trim();
  }
  if (data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)) {
    const meta: Record<string, string> = {};
    for (const [k, v] of Object.entries(data.metadata as Record<string, unknown>)) {
      const s = stringifyMeta(v);
      if (s !== undefined) meta[k] = s;
    }
    skill.metadata = meta;
  }
  const allowed = data['allowed-tools'];
  if (typeof allowed === 'string' && allowed.trim() !== '') {
    // Space-separated, but a specifier may itself contain spaces — e.g.
    // `Bash(git diff:*)` — so don't split inside parentheses.
    skill.allowedTools = allowed.trim().match(/\S+\([^)]*\)|\S+/g) ?? [];
  }

  return { ok: true, skill };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Metadata values are coerced to strings for the flat `Record<string, string>`.
 * Scalars stringify the obvious way; objects/arrays are JSON-encoded rather than
 * becoming `[object Object]`; null/undefined are dropped (return undefined).
 */
function stringifyMeta(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return undefined;
    }
  }
  return String(v);
}
