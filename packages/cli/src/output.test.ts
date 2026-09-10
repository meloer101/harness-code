import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentRunResult, Notice, Usage } from '@harness-code/core';
import { JsonSink, TextSink, toResultJSON } from './output.js';
import type { ResultJSON } from './output.js';

const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

afterEach(() => {
  stdoutWrite.mockClear();
  stderrWrite.mockClear();
});

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 80,
    ...overrides,
  };
}

function result(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    messages: [],
    usage: usage(),
    stopReason: 'end_turn',
    turns: 3,
    ...overrides,
  };
}

describe('toResultJSON', () => {
  it('emits a snake_case object close to Claude Code', () => {
    const json = toResultJSON(
      { sessionId: 'abc', stopReason: 'end_turn', turns: 3 },
      'the answer',
      usage({ costUSD: 0.0042 }),
      { usedTokens: 900, windowTokens: 1000, ratio: 0.9 },
      false,
    );
    expect(json).toEqual({
      type: 'result',
      session_id: 'abc',
      stop_reason: 'end_turn',
      turns: 3,
      result: 'the answer',
      is_error: false,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cached_input_tokens: 80,
        cost_usd: 0.0042,
      },
      context: { used_tokens: 900, window_tokens: 1000, ratio: 0.9 },
    } satisfies ResultJSON);
  });

  it('omits usage/context when absent', () => {
    const json = toResultJSON({ sessionId: 'x', stopReason: 'max_turns', turns: 0 }, '');
    expect(json.usage).toBeUndefined();
    expect(json.context).toBeUndefined();
    expect(json.is_error).toBe(false);
  });
});

describe('JsonSink', () => {
  it('buffers assistant text and emits one JSON object on finish', () => {
    const sink = new JsonSink();
    sink.event({ type: 'text_delta', text: 'hello ' });
    sink.event({ type: 'text_delta', text: 'world' });
    sink.turn('m/1', result());
    sink.finish({ sessionId: 's1', stopReason: 'end_turn', turns: 3, usage: usage() });

    const wrote = stdoutWrite.mock.calls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(wrote) as ResultJSON;
    expect(parsed.result).toBe('hello world');
    expect(parsed.session_id).toBe('s1');
    expect(parsed.usage?.input_tokens).toBe(100);
  });

  it('flags tool errors as is_error', () => {
    const sink = new JsonSink();
    sink.event({ type: 'tool_call_end', id: 'c', name: 'bash', result: { content: 'Denied', isError: true } });
    sink.finish({ sessionId: 's', stopReason: 'end_turn', turns: 0 });

    const wrote = stdoutWrite.mock.calls.map((c) => String(c[0])).join('');
    expect((JSON.parse(wrote) as ResultJSON).is_error).toBe(true);
  });

  it('flags max_tokens and content_filter stops as is_error', () => {
    for (const stopReason of ['max_tokens', 'content_filter'] as const) {
      stdoutWrite.mockClear();
      const sink = new JsonSink();
      sink.finish({ sessionId: 's', stopReason, turns: 1 });
      const parsed = JSON.parse(stdoutWrite.mock.calls.map((c) => String(c[0])).join('')) as ResultJSON;
      expect(parsed.is_error).toBe(true);
      expect(parsed.stop_reason).toBe(stopReason);
    }
  });

  it('drops a retried model call’s partial text from the result', () => {
    const sink = new JsonSink();
    sink.event({ type: 'text_delta', text: 'turn one. ' });
    sink.event({ type: 'turn_end', usage: usage() });
    sink.event({ type: 'text_delta', text: 'half an ans' });
    sink.event({ type: 'turn_retry', attempt: 1, maxAttempts: 2, delayMs: 0, message: 'dropped' });
    sink.event({ type: 'text_delta', text: 'the answer' });
    sink.event({ type: 'turn_end', usage: usage() });
    sink.finish({ sessionId: 's', stopReason: 'end_turn', turns: 2 });

    const wrote = stdoutWrite.mock.calls.map((c) => String(c[0])).join('');
    expect((JSON.parse(wrote) as ResultJSON).result).toBe('turn one. the answer');
  });

  it('writes nothing to stderr when progress is off (the default)', () => {
    const sink = new JsonSink();
    sink.event({ type: 'tool_call_start', id: 'c', name: 'bash', input: { command: 'ls' } });
    sink.notice({ kind: 'session-start', level: 'info', text: 'session abc' });
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it('streams JSONL progress to stderr and keeps stdout to the one result', () => {
    const sink = new JsonSink({ progress: true });
    sink.notice({ kind: 'session-start', level: 'info', text: 'session abc' });
    sink.event({ type: 'text_delta', text: 'looking' });
    sink.event({ type: 'tool_call_start', id: 'c', name: 'bash', input: { command: 'ls' } });
    sink.event({ type: 'tool_call_end', id: 'c', name: 'bash', result: { content: 'nope', isError: true } });
    sink.event({ type: 'turn_end', usage: usage() });
    sink.event({ type: 'stop', reason: 'end_turn' });
    sink.finish({ sessionId: 's', stopReason: 'end_turn', turns: 1 });

    const lines = stderrWrite.mock.calls
      .map((c) => String(c[0]))
      .join('')
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.type)).toEqual(['notice', 'tool_start', 'tool_end', 'turn_end', 'stop']);
    expect(lines[0]).toMatchObject({ kind: 'session-start', level: 'info', text: 'session abc' });
    expect(lines[1]).toMatchObject({ id: 'c', name: 'bash', input: '{"command":"ls"}' });
    expect(lines[2]).toMatchObject({ is_error: true, output_bytes: 4, error: 'nope' });
    expect(lines[3]).toMatchObject({ text_chars: 7, usage: { input_tokens: 100 } });
    for (const l of lines) expect(typeof l.ts).toBe('number');

    const stdout = stdoutWrite.mock.calls.map((c) => String(c[0])).join('');
    expect(stdout.trimEnd().split('\n')).toHaveLength(1);
    expect((JSON.parse(stdout) as ResultJSON).type).toBe('result');
  });

  it('fail() still writes one result object, flagged as an error', () => {
    const sink = new JsonSink({ progress: true });
    sink.event({ type: 'text_delta', text: 'turn one. ' });
    sink.event({ type: 'turn_end', usage: usage() });
    sink.event({ type: 'text_delta', text: 'half an ans' }); // the call that died
    sink.fail({
      sessionId: 's',
      turns: 1,
      usage: usage(),
      error: { message: 'Could not reach ollama', kind: 'network' },
    });

    const stdout = stdoutWrite.mock.calls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(stdout) as ResultJSON;
    expect(parsed).toMatchObject({
      type: 'result',
      session_id: 's',
      stop_reason: 'error',
      turns: 1,
      result: 'turn one.',
      is_error: true,
      usage: { input_tokens: 100 },
      error: { message: 'Could not reach ollama', kind: 'network' },
    });
    const stderr = stderrWrite.mock.calls.map((c) => String(c[0])).join('').trimEnd().split('\n');
    expect(JSON.parse(stderr.at(-1)!)).toMatchObject({ type: 'error', kind: 'network' });
  });

  it('omits the error field on a normal finish', () => {
    const sink = new JsonSink();
    sink.finish({ sessionId: 's', stopReason: 'end_turn', turns: 0 });
    const stdout = stdoutWrite.mock.calls.map((c) => String(c[0])).join('');
    expect((JSON.parse(stdout) as ResultJSON).error).toBeUndefined();
  });
});

describe('TextSink', () => {
  it('streams text to stdout and notices to stderr', () => {
    const sink = new TextSink('m/1');
    sink.event({ type: 'text_delta', text: 'hi' });
    const notice: Notice = { kind: 'session-start', level: 'info', text: 'session abc' };
    sink.notice(notice);

    expect(stdoutWrite.mock.calls.map((c) => String(c[0])).join('')).toContain('hi');
    expect(stderrWrite.mock.calls.map((c) => String(c[0])).join('')).toContain('session abc');
  });

  it('renders a tool call start/end', () => {
    const sink = new TextSink('m/1');
    sink.event({ type: 'tool_call_start', id: 'c', name: 'bash', input: { command: 'ls' } });
    sink.event({ type: 'tool_call_end', id: 'c', name: 'bash', result: { content: 'ok' } });

    const out = stdoutWrite.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('[tool_use bash]');
    expect(out).toContain('ls');
  });

  it('writes the session footer on finish', () => {
    const sink = new TextSink('m/1');
    sink.finish({ sessionId: 's1', stopReason: 'end_turn', turns: 3, usage: usage() });
    expect(stderrWrite.mock.calls.map((c) => String(c[0])).join('')).toContain('session s1 · stop: end_turn');
  });

  it('fail() leaves the session id for --resume and nothing on stdout', () => {
    const sink = new TextSink('m/1');
    sink.fail({ sessionId: 's1', turns: 0, error: { message: 'boom' } });
    expect(stderrWrite.mock.calls.map((c) => String(c[0])).join('')).toContain('session s1 · stop: error');
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});
