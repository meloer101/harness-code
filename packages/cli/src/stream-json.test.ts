import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Usage } from '@harness-code/core';
import { StreamJsonSink } from './stream-json.js';

const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

afterEach(() => {
  stdoutWrite.mockClear();
});

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 0,
    ...overrides,
  };
}

function lines(): Array<Record<string, unknown>> {
  return stdoutWrite.mock.calls
    .map((c) => String(c[0]).trim())
    .filter(Boolean)
    .map((s) => JSON.parse(s) as Record<string, unknown>);
}

describe('StreamJsonSink', () => {
  it('delays turn.completed until the next model stream (or stop)', () => {
    const sink = new StreamJsonSink('m/1');
    sink.start('sess-1');

    sink.event({ type: 'text_delta', text: 'hi ' });
    sink.event({ type: 'text_delta', text: 'one' });
    sink.event({ type: 'turn_end', usage: usage({ outputTokens: 1 }) });
    sink.event({ type: 'tool_call_start', id: 'call_1', name: 'bash', input: { command: 'ls' } });
    sink.event({
      type: 'tool_call_end',
      id: 'call_1',
      name: 'bash',
      result: { content: 'ok' },
    });

    const mid = lines();
    expect(mid.find((l) => l.type === 'turn.completed')).toBeUndefined();
    expect(mid.filter((l) => l.type === 'turn.started')).toHaveLength(1);

    const toolStarted = mid.find(
      (l) => l.type === 'item.started' && (l.item as { id: string }).id === 'call_1',
    );
    const toolCompleted = mid.find(
      (l) => l.type === 'item.completed' && (l.item as { id: string }).id === 'call_1',
    );
    expect(toolStarted).toBeDefined();
    expect(toolCompleted).toBeDefined();
    expect((toolStarted!.item as { id: string }).id).toBe((toolCompleted!.item as { id: string }).id);

    sink.event({ type: 'text_delta', text: 'two' });
    const afterSecond = lines();
    const firstCompletedIdx = afterSecond.findIndex(
      (l) => l.type === 'turn.completed' && l.turn === 1,
    );
    const secondStartedIdx = afterSecond.findIndex((l) => l.type === 'turn.started' && l.turn === 2);
    expect(firstCompletedIdx).toBeGreaterThanOrEqual(0);
    expect(secondStartedIdx).toBeGreaterThan(firstCompletedIdx);

    sink.event({ type: 'turn_end', usage: usage({ outputTokens: 2 }) });
    sink.event({ type: 'stop', reason: 'end_turn' });
    sink.turn('m/1', {
      messages: [],
      usage: usage(),
      stopReason: 'end_turn',
      turns: 2,
    });
    sink.finish({ sessionId: 'sess-1', stopReason: 'end_turn', turns: 2, usage: usage() });

    const all = lines();
    expect(all.filter((l) => l.type === 'turn.completed')).toHaveLength(2);
    expect(all.filter((l) => l.type === 'result')).toHaveLength(1);
    const result = all.find((l) => l.type === 'result')!;
    expect(result.result).toBe('hi onetwo');
    expect(result.session_id).toBe('sess-1');
  });

  it('discards partial items on turn_retry and keeps only the final text', () => {
    const sink = new StreamJsonSink('m/1');
    sink.start('s');

    sink.event({ type: 'text_delta', text: 'half' });
    sink.event({
      type: 'turn_retry',
      attempt: 1,
      maxAttempts: 2,
      delayMs: 10,
      message: 'rate limited',
    });
    sink.event({ type: 'text_delta', text: 'full answer' });
    sink.event({ type: 'turn_end', usage: usage() });
    sink.event({ type: 'stop', reason: 'end_turn' });
    sink.finish({ sessionId: 's', stopReason: 'end_turn', turns: 1 });

    const all = lines();
    expect(all.some((l) => l.type === 'turn_retry')).toBe(true);

    const completedMsgs = all.filter(
      (l) =>
        l.type === 'item.completed' && (l.item as { type: string }).type === 'agent_message',
    );
    expect(completedMsgs).toHaveLength(1);
    expect((completedMsgs[0]!.item as { text: string }).text).toBe('full answer');

    const result = all.find((l) => l.type === 'result')!;
    expect(result.result).toBe('full answer');
    expect(result.result).not.toContain('half');
  });

  it('fail() writes error then result with is_error', () => {
    const sink = new StreamJsonSink('m/1');
    sink.start('s');
    sink.event({ type: 'text_delta', text: 'partial' });
    sink.fail({
      sessionId: 's',
      turns: 0,
      error: { message: 'boom', kind: 'network' },
    });

    const all = lines();
    const errIdx = all.findIndex((l) => l.type === 'error');
    const resultIdx = all.findIndex((l) => l.type === 'result');
    expect(errIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThan(errIdx);
    expect(all[errIdx]).toMatchObject({ message: 'boom', kind: 'network' });
    expect(all[resultIdx]).toMatchObject({
      type: 'result',
      stop_reason: 'error',
      is_error: true,
      result: '',
    });
  });
});
