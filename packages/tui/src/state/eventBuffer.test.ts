import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '@harness-code/core';

import { EventBuffer } from './eventBuffer.js';

function start(id: string, name = 'bash'): AgentEvent {
  return { type: 'tool_call_start', id, name, input: { command: 'ls' } };
}
function end(id: string, name = 'bash'): AgentEvent {
  return { type: 'tool_call_end', id, name, result: { content: 'ok' } };
}

describe('EventBuffer', () => {
  it('sets a batch boundary only when the last in-flight tool completes', () => {
    const b = new EventBuffer();
    b.onEvent(start('a'));
    b.onEvent(start('b'));
    expect(b.hasBatchBoundary()).toBe(false);

    b.onEvent(end('a')); // b still running
    expect(b.hasBatchBoundary()).toBe(false);
    expect(b.hasRunningTool()).toBe(true);

    b.onEvent(end('b'));
    expect(b.hasBatchBoundary()).toBe(true);
    expect(b.hasRunningTool()).toBe(false);
    expect(b.snapshot().tools.map((t) => t.running)).toEqual([false, false]);
  });

  it('reset clears the boundary and the tool ledger', () => {
    const b = new EventBuffer();
    b.onEvent(start('a'));
    b.onEvent(end('a'));
    expect(b.hasBatchBoundary()).toBe(true);

    b.reset();
    expect(b.hasBatchBoundary()).toBe(false);
    expect(b.hasRunningTool()).toBe(false);
    expect(b.snapshot()).toEqual({ thinking: '', text: '', tools: [] });

    // a later batch can set the boundary again
    b.onEvent(start('b'));
    b.onEvent(end('b'));
    expect(b.hasBatchBoundary()).toBe(true);
  });

  it('ignores tool_call_end for an unknown id (already committed)', () => {
    const b = new EventBuffer();
    b.onEvent(start('a'));
    b.onEvent(end('a'));
    b.reset();

    b.onEvent(end('a')); // stale completion from the committed batch
    expect(b.hasBatchBoundary()).toBe(false);
    expect(b.hasRunningTool()).toBe(false);
  });

  it('turn_retry drops only the failed turn’s deltas', () => {
    const b = new EventBuffer();
    const context: AgentEvent = {
      type: 'context',
      usedTokens: 1,
      windowTokens: 10,
      ratio: 0.1,
      breakdown: { system: 0, skills: 0, projectMemory: 0, toolSchemas: 0, history: 1, total: 1 },
    };
    b.onEvent(context);
    b.onEvent({ type: 'text_delta', text: 'turn one. ' }); // not yet committed
    b.onEvent(context); // next model call begins
    b.onEvent({ type: 'thinking_delta', text: 'hmm' });
    b.onEvent({ type: 'text_delta', text: 'half an ans' });
    b.onEvent({ type: 'turn_retry', attempt: 1, maxAttempts: 2, delayMs: 0, message: 'dropped' });
    b.onEvent({ type: 'text_delta', text: 'the answer' });

    expect(b.snapshot()).toMatchObject({ thinking: '', text: 'turn one. the answer' });
  });
});
