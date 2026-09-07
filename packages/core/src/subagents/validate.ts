/**
 * Sub-agent frontmatter validation. Same posture as `skills/validate.ts`: a
 * definition that fails is skipped with a one-line reason, never fatal.
 */

import matter from 'gray-matter';

import type { AgentDefinition, AgentSource } from './types.js';

export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 1024;

export type ValidationResult =
  | { ok: true; agent: AgentDefinition }
  | { ok: false; reason: string };

export function parseAgent(input: {
  raw: string;
  /** Filename without `.md` — `name` must match this. */
  stem: string;
  source: AgentSource;
}): ValidationResult {
  let data: Record<string, unknown>;
  let body: string;
  try {
    const parsed = matter(input.raw);
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
  if (name !== input.stem) {
    return { ok: false, reason: `name "${name}" does not match its file "${input.stem}.md"` };
  }

  const description = data.description;
  if (typeof description !== 'string' || description.trim() === '') {
    return { ok: false, reason: 'frontmatter is missing a non-empty "description"' };
  }
  if (description.length > MAX_DESCRIPTION) {
    return { ok: false, reason: `description exceeds ${MAX_DESCRIPTION} characters` };
  }
  if (body === '') {
    return { ok: false, reason: 'the body (role instructions) is empty' };
  }

  const agent: AgentDefinition = {
    name,
    description: description.trim(),
    body,
    source: input.source,
  };

  const tools = data.tools;
  if (typeof tools === 'string' && tools.trim() !== '') {
    agent.tools = tools
      .split(/[\s,]+/)
      .filter((t) => t !== '')
      .map((t) => t.toLowerCase());
  } else if (Array.isArray(tools)) {
    agent.tools = tools.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase());
  }

  if (typeof data.model === 'string' && data.model.trim() !== '') {
    agent.model = data.model.trim();
  }

  return { ok: true, agent };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
