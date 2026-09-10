import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DEFAULT_CAPABILITIES } from '../provider/capabilities.js';
import { ScriptedProvider } from '../provider/mock.js';
import type { ResolvedModel } from '../provider/router.js';
import { allowAllHooks } from '../agent/hooks.js';
import { buildSubagentSystemPrompt } from '../agent/prompt.js';
import type { ToolSpec } from '../tools/types.js';
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

const readSpy = (calls: string[]): ToolSpec<{ path: string }> => ({
  name: 'read',
  description: 'read a file',
  schema: z.object({ path: z.string() }),
  readOnly: true,
  concurrencySafe: true,
  async execute(input) {
    calls.push(input.path);
    return { content: `contents of ${input.path}` };
  },
});

const base = {
  system: buildSubagentSystemPrompt({ cwd: '/w', platform: 'linux', role: 'search' }),
  hooks: allowAllHooks,
  cwd: '/w',
};

describe('runSubagent', () => {
  it('returns the final assistant text as the report', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'read', input: { path: 'a.ts' } }] },
      { text: 'The answer is in a.ts:10.' },
    ]);
    const calls: string[] = [];
    const result = await runSubagent({
      ...base,
      model: model(provider),
      tools: [readSpy(calls)],
      prompt: 'where is the answer',
    });
    expect(result.report).toBe('The answer is in a.ts:10.');
    expect(result.turns).toBe(2);
    expect(result.stopReason).toBe('end_turn');
    expect(calls).toEqual(['a.ts']);
  });

  it('falls back to a note when the sub-agent produced no text', async () => {
    const provider = new ScriptedProvider([{ text: '', stopReason: 'end_turn' }]);
    const result = await runSubagent({
      ...base,
      model: model(provider),
      tools: [],
      prompt: 'x',
    });
    expect(result.report).toMatch(/without producing a text answer/);
  });

  it('starts from just the task prompt — no parent history leaks in', async () => {
    const provider = new ScriptedProvider([{ text: 'done' }]);
    const snapshots: number[] = [];
    const spy = {
      id: provider.id,
      async *stream(req: Parameters<typeof provider.stream>[0]) {
        snapshots.push(req.messages.length); // captured before the loop appends
        yield* provider.stream(req);
      },
      complete: provider.complete.bind(provider),
    };
    await runSubagent({
      ...base,
      model: model(spy as unknown as ScriptedProvider),
      tools: [],
      prompt: 'the only task',
    });
    expect(snapshots[0]).toBe(1);
  });

  it('forces a text summary on the final turn instead of another tool call', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'read', input: { path: 'a.ts' } }] },
      { text: 'Found nothing useful; suggest grepping for TODO next.' },
    ]);
    const result = await runSubagent({
      ...base,
      model: model(provider),
      tools: [readSpy([])],
      prompt: 'explore',
      maxTurns: 2,
    });
    expect(result.stopReason).toBe('end_turn');
    expect(result.report).toMatch(/Found nothing useful/);
    expect(provider.requests[1]?.tools).toBeUndefined();
  });
});
