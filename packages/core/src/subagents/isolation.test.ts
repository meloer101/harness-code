/**
 * End-to-end context isolation: when the parent loop dispatches a sub-agent via
 * the `task` tool, only the sub-agent's final report reaches the parent's
 * history — its noisy tool traffic (grep queries, file contents it read) stays
 * in the child's own window and never pollutes the parent.
 *
 * The child-side of isolation (a fresh SessionState, report-only return, forced
 * final summary) is covered in `run.test.ts`; the tool-narrowing that keeps an
 * explore agent read-only is covered in `task-tool.test.ts`. This file asserts
 * the property the parent actually cares about: its transcript stays clean.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { allowAllHooks } from '../agent/hooks.js';
import { AgentLoop } from '../agent/loop.js';
import { buildSubagentSystemPrompt } from '../agent/prompt.js';
import { SessionState } from '../agent/session.js';
import { DEFAULT_CAPABILITIES } from '../provider/capabilities.js';
import { ScriptedProvider } from '../provider/mock.js';
import type { ResolvedModel } from '../provider/router.js';
import { userText } from '../provider/types.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolSpec } from '../tools/types.js';
import { createTaskTool } from './task-tool.js';
import { runSubagent } from './run.js';

function model(provider: ScriptedProvider): ResolvedModel {
  return {
    provider,
    providerId: provider.id,
    model: 'm',
    ref: `${provider.id}/m`,
    capabilities: DEFAULT_CAPABILITIES,
  };
}

// A noisy read-only tool the child uses; its query and output carry unique
// markers we then assert never surface in the parent transcript.
const NOISE_QUERY = 'NOISE_QUERY_a1b2c3';
const NOISE_OUTPUT = 'NOISE_OUTPUT_d4e5f6';
const grepSpy: ToolSpec<{ pattern: string }> = {
  name: 'grep',
  description: 'search',
  schema: z.object({ pattern: z.string() }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input) {
    return { content: `matched "${input.pattern}"\n${NOISE_OUTPUT} at foo.ts:12\n` };
  },
};

const REPORT = 'SUMMARY_REPORT: the answer lives at foo.ts:12';

describe('sub-agent context isolation (parent side)', () => {
  it('leaks only the report into the parent history, not the child tool traffic', async () => {
    // Child: greps (noisy) then summarizes.
    const child = new ScriptedProvider(
      [
        { toolCalls: [{ name: 'grep', input: { pattern: NOISE_QUERY } }] },
        { text: REPORT },
      ],
      'child',
    );
    // Parent: dispatches explore, then answers.
    const parent = new ScriptedProvider(
      [
        { toolCalls: [{ name: 'task', input: { subagent_type: 'explore', prompt: 'find X' } }] },
        { text: 'parent done' },
      ],
      'parent',
    );

    const taskTool = createTaskTool({
      agents: [{ name: 'explore', description: 'read-only search', body: 'search', source: 'builtin', tools: ['grep'] }],
      run: (_def, subPrompt, runCtx) =>
        runSubagent({
          model: model(child),
          tools: [grepSpy],
          system: buildSubagentSystemPrompt({ cwd: '/w', platform: 'linux', role: 'search' }),
          hooks: allowAllHooks,
          cwd: '/w',
          prompt: subPrompt,
          ...(runCtx.signal ? { signal: runCtx.signal } : {}),
        }),
    });

    const loop = new AgentLoop({
      model: model(parent),
      tools: new ToolRegistry([taskTool as unknown as ToolSpec<unknown>]),
      cwd: '/w',
      session: new SessionState(),
      hooks: allowAllHooks,
    });

    const result = await loop.run([userText('find X for me')]);

    const transcript = JSON.stringify(result.messages);
    // The report propagates to the parent (as the task tool_result)…
    expect(transcript).toContain('SUMMARY_REPORT');
    // …but the child's noisy search traffic does not.
    expect(transcript).not.toContain(NOISE_QUERY);
    expect(transcript).not.toContain(NOISE_OUTPUT);

    // The child ran its own turns; the parent only ever saw two of its own.
    expect(child.callCount).toBe(2);
    expect(parent.callCount).toBe(2);
  });
});
