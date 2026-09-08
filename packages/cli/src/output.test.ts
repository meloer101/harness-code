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
});
