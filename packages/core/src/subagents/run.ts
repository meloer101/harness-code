/**
 * Run one sub-agent to completion and extract its report.
 *
 * A thin wrapper over `AgentLoop`: the caller (the CLI) has already resolved the
 * model, built the narrowed tool registry, the child permission hooks and the
 * role system prompt — this just news up the loop with a **fresh** `SessionState`
 * (so the sub-agent's file reads and todos never touch the parent's), runs it on
 * the single task message, and returns the last assistant text plus what it cost.
 */

import { AgentLoop } from '../agent/loop.js';
import type { AgentEvent } from '../agent/loop.js';
import type { AgentHooks } from '../agent/hooks.js';
import { SessionState } from '../agent/session.js';
import type { ResolvedModel } from '../provider/router.js';
import { textOf, userText } from '../provider/types.js';
import type { SystemSegment } from '../provider/types.js';
import { ToolRegistry } from '../tools/registry.js';
import type { AnyToolSpec } from '../tools/types.js';
import type { SubagentResult } from './types.js';

/**
 * The tool set a sub-agent gets: the parent's builtin specs, minus `task` (no
 * recursive dispatch), and — when the definition names `tools` — filtered to
 * that list. A sub-agent can only ever narrow the parent's tools, never add.
 */
export function subagentToolSpecs(
  parentSpecs: readonly AnyToolSpec[],
  def: { tools?: string[] },
): AnyToolSpec[] {
  return parentSpecs.filter(
    (t) => t.name !== 'task' && (!def.tools || def.tools.includes(t.name)),
  );
}

export interface RunSubagentOptions {
  model: ResolvedModel;
  tools: readonly AnyToolSpec[];
  system: SystemSegment[];
  hooks: AgentHooks;
  cwd: string;
  prompt: string;
  maxTurns?: number;
  maxOutputTokens?: number;
  temperature?: number;
  contextCompactRatio?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export async function runSubagent(opts: RunSubagentOptions): Promise<SubagentResult> {
  let turns = 0;
  const loop = new AgentLoop({
    model: opts.model,
    tools: new ToolRegistry(opts.tools),
    cwd: opts.cwd,
    system: opts.system,
    session: new SessionState(),
    hooks: opts.hooks,
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.contextCompactRatio !== undefined
      ? { contextCompactRatio: opts.contextCompactRatio }
      : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    onEvent: (event) => {
      if (event.type === 'turn_end') turns++;
      opts.onEvent?.(event);
    },
  });

  const result = await loop.run([userText(opts.prompt)]);

  const last = [...result.messages].reverse().find((m) => m.role === 'assistant');
  const report = last ? textOf(last.content).trim() : '';

  return {
    report: report || '(the sub-agent finished without producing a text answer)',
    usage: result.usage,
    stopReason: result.stopReason,
    turns,
  };
}
