import { describe, expect, it, vi } from 'vitest';

import { SessionState } from '../agent/session.js';
import { emptyUsage } from '../provider/types.js';
import { createTaskTool } from './task-tool.js';
import { subagentToolSpecs } from './run.js';
import type { AgentDefinition, SubagentResult } from './types.js';
import type { AnyToolSpec } from '../tools/types.js';

const explore: AgentDefinition = {
  name: 'explore',
  description: 'read-only search',
  body: 'search stuff',
  source: 'builtin',
  tools: ['read', 'glob', 'grep'],
};

const ctx = { cwd: '/w', session: new SessionState() };
const result = (over: Partial<SubagentResult> = {}): SubagentResult => ({
  report: 'the answer is in foo.ts:12',
  usage: { ...emptyUsage(), inputTokens: 4000, outputTokens: 100 },
  stopReason: 'end_turn',
  turns: 5,
  ...over,
});

describe('task tool', () => {
  it('dispatches the named agent and appends a footer to its report', async () => {
    const run = vi.fn(async () => result());
    const tool = createTaskTool({ agents: [explore], run });
    const res = await tool.execute({ subagent_type: 'explore', prompt: 'where is X' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('the answer is in foo.ts:12');
    expect(res.content).toContain('— explore · 5 turns · 4.1k tokens');
    expect(run).toHaveBeenCalledWith(explore, 'where is X', expect.anything());
  });

  it('errors with the roster on an unknown agent', async () => {
    const tool = createTaskTool({ agents: [explore], run: async () => result() });
    const res = await tool.execute({ subagent_type: 'nope', prompt: 'x' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('explore');
  });

  it('surfaces a non-end_turn stop in the footer', async () => {
    const tool = createTaskTool({
      agents: [explore],
      run: async () => result({ stopReason: 'max_turns' }),
    });
    const res = await tool.execute({ subagent_type: 'explore', prompt: 'x' }, ctx);
    expect(res.content).toContain('stopped: max_turns');
  });

  it('is concurrency-safe so parallel dispatch works', () => {
    const tool = createTaskTool({ agents: [], run: async () => result() });
    expect(tool.concurrencySafe).toBe(true);
    expect(tool.readOnly).toBe(false);
  });
});

describe('subagentToolSpecs', () => {
  const spec = (name: string): AnyToolSpec =>
    ({ name, description: '', readOnly: true, concurrencySafe: true }) as unknown as AnyToolSpec;
  const parent = ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'todo', 'task'].map(spec);

  it('always drops task (no recursive dispatch)', () => {
    expect(subagentToolSpecs(parent, {}).map((t) => t.name)).not.toContain('task');
  });

  it('filters to the definition tools when given', () => {
    const out = subagentToolSpecs(parent, { tools: ['read', 'glob', 'grep'] });
    expect(out.map((t) => t.name).sort()).toEqual(['glob', 'grep', 'read']);
  });

  it('keeps everything but task when no tools are named', () => {
    expect(subagentToolSpecs(parent, {}).map((t) => t.name)).toEqual([
      'read',
      'write',
      'edit',
      'glob',
      'grep',
      'bash',
      'todo',
    ]);
  });
});
