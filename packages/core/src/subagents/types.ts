/**
 * A sub-agent definition: a `<name>.md` file with YAML frontmatter and a
 * Markdown body that becomes the sub-agent's role instructions.
 *
 * A sub-agent runs in its own context window with a narrowed tool set and hands
 * only a final report back to the parent — the point is that a search-heavy job
 * does not flood the parent's history with tool output.
 */

export type AgentSource = 'project' | 'user' | 'builtin';

export interface AgentDefinition {
  /** `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤64 chars, equal to the filename stem. */
  name: string;
  /** What the sub-agent is for — the parent model reads this to pick one. */
  description: string;
  /** Role instructions (the Markdown body), injected as the sub-agent's system overlay. */
  body: string;
  source: AgentSource;
  /**
   * Builtin tool names the sub-agent may use. Omitted = inherit the parent's
   * full builtin set. `task` is always excluded regardless (no recursion).
   */
  tools?: string[];
  /** `provider/model` override; omitted = the parent's model. */
  model?: string;
}

export interface SubagentResult {
  /** The sub-agent's final answer — its last assistant message, text only. */
  report: string;
  usage: import('../provider/types.js').Usage;
  stopReason: string;
  turns: number;
}
