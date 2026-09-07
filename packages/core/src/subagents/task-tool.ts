/**
 * The `task` tool — dispatch a sub-agent.
 *
 * The model names a sub-agent and gives it a prompt; the sub-agent runs in its
 * own context window (see `run.ts`) and only its final report comes back as the
 * tool result. `concurrencySafe: true` so several `task` calls in one turn run
 * in parallel (bounded by the loop's concurrency cap).
 *
 * Actually running a sub-agent needs the provider registry, permission engine
 * and settings — all of which live in the CLI — so the run itself is injected as
 * `deps.run`, the same closure-over-host pattern `createSkillTool` uses.
 */

import { z } from 'zod';

import type { ToolSpec } from '../tools/types.js';
import type { AgentDefinition, SubagentResult } from './types.js';

const schema = z.object({
  subagent_type: z.string().describe('The name of the sub-agent to dispatch (see the list above).'),
  prompt: z
    .string()
    .describe('The full task for the sub-agent. It has no other context — be self-contained.'),
  description: z
    .string()
    .optional()
    .describe('A 3-5 word label for this dispatch, for progress display.'),
});

export interface TaskToolDeps {
  agents: readonly AgentDefinition[];
  run(
    agent: AgentDefinition,
    prompt: string,
    ctx: { signal?: AbortSignal },
  ): Promise<SubagentResult>;
}

export function createTaskTool(deps: TaskToolDeps): ToolSpec<z.infer<typeof schema>> {
  const roster = deps.agents.map((a) => `- ${a.name}: ${a.description}`).join('\n');
  return {
    name: 'task',
    description:
      'Dispatch a sub-agent to handle a self-contained sub-task in its own context window; ' +
      'you get back only its final report. Use it to keep large search / investigation output ' +
      'out of this conversation. Available sub-agents:\n' +
      roster,
    schema,
    readOnly: false,
    concurrencySafe: true,
    async execute(input, ctx) {
      const agent = deps.agents.find((a) => a.name === input.subagent_type);
      if (!agent) {
        const known = deps.agents.map((a) => a.name).join(', ') || '(none)';
        return {
          content: `No sub-agent named "${input.subagent_type}". Available: ${known}.`,
          isError: true,
        };
      }

      let result: SubagentResult;
      try {
        result = await deps.run(agent, input.prompt, {
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      } catch (err) {
        return {
          content: `Sub-agent "${agent.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }

      const footer =
        `\n\n— ${agent.name} · ${result.turns} turn${result.turns === 1 ? '' : 's'} · ` +
        `${fmtTokens(result.usage.inputTokens + result.usage.outputTokens)} tokens` +
        (result.stopReason !== 'end_turn' ? ` · stopped: ${result.stopReason}` : '');
      return { content: result.report + footer };
    },
  };
}

function fmtTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}
