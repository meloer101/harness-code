/**
 * A Skill: a folder with a `SKILL.md` (YAML frontmatter + Markdown body) and
 * optional `scripts/` / `references/` / `assets/` alongside it.
 *
 * Only `name` and `description` are loaded into the system prompt at startup —
 * everything else waits until the model calls the `skill` tool to activate it.
 * The format follows the Agent Skills spec (agentskills.io/specification) so an
 * ecosystem skill drops in unchanged.
 */

export type SkillSource = 'project' | 'user' | 'builtin';

export interface Skill {
  /** `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤64 chars, equal to the parent directory name. */
  name: string;
  /** What it does and when to use it. Non-empty, ≤1024 chars. */
  description: string;
  /** The Markdown body after the frontmatter — the tier-2 payload. */
  body: string;
  /** Absolute path of the skill directory (for resolving `references/…` etc.). */
  dir: string;
  source: SkillSource;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  /**
   * Parsed from the space-separated `allowed-tools` frontmatter string. When
   * present, activating this skill narrows the tool set offered to the model to
   * those matching these rules (experimental field in the spec).
   */
  allowedTools?: string[];
}
