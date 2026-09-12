/**
 * The system prompt `hc agent` sends to the model.
 *
 * Kept deliberately small: one factual identity line, a handful of tagged
 * behavioral blocks (not a persona paragraph — current models are steered
 * better by short, single-purpose instructions than by role narrative), and
 * one segment of per-invocation environment facts the model has no other
 * way to know. The static segments come first so they form a stable,
 * cacheable prefix across every run; `environment` varies by cwd and goes
 * last.
 */

import type { SystemSegment } from '../provider/types.js';
import type { PermissionMode } from '../permissions/types.js';
import { orderSystemSegments } from '../context/cache.js';

const IDENTITY = "You are a coding agent working directly in a developer's codebase through tool calls.";

/**
 * The behavioral blocks, exported so the compactor can pass them to the
 * summarizer as the baseline working agreement — the digest's style memo then
 * only has to record deviations from this, not restate it.
 */
export const AGENT_CONVENTIONS = `<tool_usage>
Read a file with \`read\` before editing it with \`edit\` — editing a file this session hasn't read yet is rejected. Prefer \`glob\` and \`grep\` over shelling out to \`bash\` for finding files or searching text: they're faster and run safely in parallel with other reads. When you need several independent tool calls — reading multiple files, or unrelated read-only lookups — issue them together in the same turn rather than one per turn. Read the relevant file before describing what code does or why something failed; don't guess about code you haven't opened.
</tool_usage>

<code_style>
Match the style already in the file you're editing: naming, comment density, idioms. Write the simplest implementation that correctly handles the inputs this code actually receives. Validate at real trust boundaries — user input, external APIs, file and network I/O — and trust internal callers and framework guarantees otherwise; a defensive check that can't change behavior for any input this function actually receives is noise, not rigor. Change only what the task requires: no unrequested refactors, extra configurability, or cleanup of surrounding code.
</code_style>

<working_style>
Get a rough version of the actual deliverable in place early — within roughly the first third of the work — then spend the rest of the time refining it. Don't spend most of your turns reading and exploring before making a single edit to the file(s) the task is actually about; a rough first pass you iterate on beats a long investigation that runs out of turns before it produces anything. When experimenting or debugging, reuse one scratch file across attempts instead of creating a new one per attempt (\`bench.py\`, \`bench2.py\`, \`debug_v3.py\`, ...); before finishing, remove any scratch file you created that isn't part of what the task asked for.
</working_style>

<finishing>
Reach a working solution, then stop. Once the required change is in place and you have verified it once — ran the tests, reproduced the fix, checked the output — reply with a short summary and make no further tool calls. Do not re-verify repeatedly, keep polishing past what the task asked, or benchmark alternatives you will not use. Prefer the simplest approach that satisfies the task; only reach for a more elaborate one if the simple one is actually insufficient. If you are stuck, step back and reconsider the approach rather than retrying variations of it — and if you are still blocked, say so plainly and stop instead of burning turns.
</finishing>

<output_style>
Lead with the conclusion or the change you made, in plain language, in as few words as stay clear. Skip preamble like "Sure, I can help with that" or restating the request back. When a decision isn't obvious from the change itself, say why in one short sentence — the goal is that someone skimming your output understands both what changed and, when it's not self-evident, why. Say plainly when you're unsure rather than guessing with confidence.
</output_style>`;

const PLAN_MODE = `<plan_mode>
You are in plan mode. Do not change anything yet — investigate, then propose a plan and wait for approval.

1. Read the actual code first. Use \`read\`, \`glob\` and \`grep\` to open every file you would touch; do not plan against assumptions about code you have not looked at.
2. Then write the plan: what problem it solves, exactly which files and functions change, the order of steps, and how each step is verified.
3. Call \`exit_plan_mode\` with the plan to hand it over. If it is not approved, revise and call it again.

Write operations are rejected in this mode. The only writable path is \`.agent/plans/\`, and \`exit_plan_mode\` handles that for you.
</plan_mode>`;

export interface BuildAgentSystemPromptOptions {
  cwd: string;
  /** Defaults to `process.platform`; parameterized so this is testable without mocking globals. */
  platform?: string;
  /** When `plan`, a plan-mode overlay is appended after the cacheable prefix. */
  mode?: PermissionMode;
  /** Concatenated AGENTS.md / CLAUDE.md bodies, from `loadProjectMemory`. Omitted when empty. */
  projectMemory?: string;
  /** The `<available_skills>` manifest, from `SkillCatalog.manifest()`. Omitted when empty. */
  skillsManifest?: string;
}

export function buildAgentSystemPrompt(opts: BuildAgentSystemPromptOptions): SystemSegment[] {
  const platform = opts.platform ?? process.platform;
  const segments: SystemSegment[] = [
    { id: 'identity', text: IDENTITY },
    { id: 'conventions', text: AGENT_CONVENTIONS, cacheBreakpoint: true },
  ];
  // Everything below sits *after* the cacheBreakpoint conventions segment: it
  // varies by cwd / mode, and in the cacheable prefix it would wreck the
  // prompt-cache hit rate across turns. The skills manifest and project memory
  // are stable within a session, so they are safe here — just not in the shared
  // prefix.
  if (opts.skillsManifest && opts.skillsManifest.trim() !== '') {
    segments.push({ id: 'available_skills', text: opts.skillsManifest });
  }
  if (opts.projectMemory && opts.projectMemory.trim() !== '') {
    segments.push({
      id: 'project_memory',
      text:
        `<project_memory>\nStanding notes the developer left in this project. Treat them as instructions.\n\n` +
        `${opts.projectMemory}\n</project_memory>`,
    });
  }
  if (opts.mode === 'plan') {
    segments.push({ id: 'plan_mode', text: PLAN_MODE });
  }
  segments.push(environmentSegment(opts.cwd, platform));
  // Enforce the cache-stable order regardless of push order above.
  return orderSystemSegments(segments);
}

function environmentSegment(cwd: string, platform: string): SystemSegment {
  return {
    id: 'environment',
    text: `Working directory: ${cwd}\nPlatform: ${platform}\n\nPaths in tool calls are resolved against the working directory above unless given as absolute paths.`,
  };
}

export interface BuildSubagentSystemPromptOptions {
  cwd: string;
  platform?: string;
  /** The sub-agent definition's Markdown body — its role instructions. */
  role: string;
  /** Concatenated AGENTS.md / CLAUDE.md bodies. Omitted when empty. */
  projectMemory?: string;
}

/**
 * System prompt for a dispatched sub-agent. Same `identity` + `conventions`
 * prefix as the main agent (byte-identical, so the prompt cache still hits),
 * then the sub-agent's role, then project memory and environment. No skills
 * manifest and no plan-mode overlay — a sub-agent does neither.
 */
export function buildSubagentSystemPrompt(opts: BuildSubagentSystemPromptOptions): SystemSegment[] {
  const platform = opts.platform ?? process.platform;
  const segments: SystemSegment[] = [
    { id: 'identity', text: IDENTITY },
    { id: 'conventions', text: AGENT_CONVENTIONS, cacheBreakpoint: true },
    {
      id: 'agent_role',
      text: `<agent_role>\nYou are a sub-agent dispatched for one self-contained task. Do that task and nothing more. Your final message is the entire report the calling agent receives — make it complete and self-standing, and keep it tight.\n\n${opts.role.trim()}\n</agent_role>`,
    },
  ];
  if (opts.projectMemory && opts.projectMemory.trim() !== '') {
    segments.push({
      id: 'project_memory',
      text:
        `<project_memory>\nStanding notes the developer left in this project. Treat them as instructions.\n\n` +
        `${opts.projectMemory}\n</project_memory>`,
    });
  }
  segments.push(environmentSegment(opts.cwd, platform));
  return orderSystemSegments(segments);
}
