import { describe, expect, it } from 'vitest';

import type { SystemSegment, ToolDefinition } from '../provider/types.js';
import { analyzeStableParts, breakdownFrom } from './budget.js';

const sys = (id: string, text: string): SystemSegment => ({ id, text });
const tool = (name: string): ToolDefinition => ({
  name,
  description: `the ${name} tool does a thing`,
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
});

describe('analyzeStableParts', () => {
  it('counts the project_memory segment separately from the rest of system', () => {
    const parts = analyzeStableParts({
      system: [sys('identity', 'you are an agent'), sys('project_memory', 'x'.repeat(400))],
      tools: [],
    });
    expect(parts.projectMemory).toBeGreaterThan(parts.system);
    expect(parts.system).toBeGreaterThan(0);
  });

  it('reports projectMemory 0 when there is no such segment', () => {
    const parts = analyzeStableParts({ system: [sys('identity', 'hi')], tools: [] });
    expect(parts.projectMemory).toBe(0);
  });

  it('counts tool schemas', () => {
    const none = analyzeStableParts({ system: [], tools: [] });
    const some = analyzeStableParts({ system: [], tools: [tool('read'), tool('write')] });
    expect(some.toolSchemas).toBeGreaterThan(none.toolSchemas);
  });
});

describe('breakdownFrom', () => {
  it('derives history as the remainder and never goes negative', () => {
    const stable = { system: 100, projectMemory: 50, toolSchemas: 200 };
    expect(breakdownFrom(stable, 1000)).toEqual({
      system: 100,
      projectMemory: 50,
      toolSchemas: 200,
      history: 650,
      total: 1000,
    });
    expect(breakdownFrom(stable, 100).history).toBe(0);
  });
});
