import { describe, expect, it } from 'vitest';

import type { SessionSnapshot, WireEvent } from '@harness-code/protocol';

import { SessionModel, entriesFromTranscript } from './sessionModel';

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { id: 's1', modelRef: 'mock/m', mode: 'ask', transcript: [], running: false, lastSeq: 0, ...over };
}

function feed(model: SessionModel, events: WireEvent[], from = model.lastSeq + 1): void {
  events.forEach((e, i) => model.apply(from + i, e));
}

const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 };

describe('SessionModel', () => {
  it('folds one full run into user + assistant entries', () => {
    const m = new SessionModel(snapshot());
    feed(m, [
      { type: 'run_start', runId: 'r', input: 'hi' },
      { type: 'thinking_delta', text: 'hmm' },
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
    ]);
    expect(m.state.running).toBe(true);
    expect(m.state.live).toMatchObject({ thinking: 'hmm', text: 'Hello' });

    feed(m, [{ type: 'run_end', runId: 'r', stopReason: 'end_turn', usage, sessionUsage: usage }]);
    const s = m.state;
    expect(s.running).toBe(false);
    expect(s.usage).toEqual(usage);
    expect(s.live).toEqual({ thinking: '', text: '', tools: [] });
    expect(s.entries).toMatchObject([
      { kind: 'user', text: 'hi' },
      { kind: 'assistant', thinking: 'hmm', text: 'Hello', tools: [] },
    ]);
  });

  it('commits a completed tool batch as its own entry', () => {
    const m = new SessionModel(snapshot());
    feed(m, [
      { type: 'run_start', runId: 'r', input: 'go' },
      { type: 'text_delta', text: 'looking' },
      { type: 'tool_call_start', id: 't1', name: 'bash', input: { command: 'ls' } },
    ]);
    expect(m.state.live.tools[0]).toMatchObject({ id: 't1', running: true });
    feed(m, [{ type: 'tool_call_end', id: 't1', name: 'bash', result: { content: 'a\nb' } }]);
    const s = m.state;
    expect(s.live.tools).toHaveLength(0);
    expect(s.entries.at(-1)).toMatchObject({
      kind: 'assistant',
      text: 'looking',
      tools: [{ id: 't1', running: false, result: { content: 'a\nb' } }],
    });
  });

  it('drops duplicate and stale seqs', () => {
    const m = new SessionModel(snapshot({ lastSeq: 5 }));
    expect(m.apply(5, { type: 'run_start', runId: 'r', input: 'old' })).toBe(false);
    expect(m.apply(6, { type: 'run_start', runId: 'r', input: 'new' })).toBe(true);
    expect(m.apply(6, { type: 'run_start', runId: 'r', input: 'dup' })).toBe(false);
    expect(m.state.entries).toMatchObject([{ kind: 'user', text: 'new' }]);
  });

  it('tracks ask/plan ids and clears them on resolved', () => {
    const m = new SessionModel(snapshot());
    feed(m, [{ type: 'ask', askId: 'a1', toolName: 'bash', input: { command: 'rm x' }, reason: 'why' }]);
    expect(m.state.pendingAsk).toMatchObject({ toolName: 'bash' });
    expect(m.state.askId).toBe('a1');
    feed(m, [{ type: 'resolved', requestId: 'a1', by: 'user' }]);
    expect(m.state.pendingAsk).toBeNull();
    expect(m.state.askId).toBeNull();

    feed(m, [{ type: 'plan', planId: 'p1', title: 'T', body: 'B' }]);
    expect(m.state.planId).toBe('p1');
    feed(m, [{ type: 'resolved', requestId: 'p1', by: 'abort' }]);
    expect(m.state.pendingPlan).toBeNull();
  });

  it('turns run_error and aborts into notices', () => {
    const m = new SessionModel(snapshot());
    feed(m, [
      { type: 'run_start', runId: 'r', input: 'x' },
      { type: 'text_delta', text: 'partial' },
      { type: 'run_end', runId: 'r', stopReason: 'aborted', usage, sessionUsage: usage },
      { type: 'run_start', runId: 'r2', input: '/nope' },
      { type: 'run_error', runId: 'r2', message: 'unknown command "/nope"' },
    ]);
    expect(m.state.entries.map((e) => e.kind)).toEqual(['user', 'assistant', 'notice', 'user', 'notice']);
    expect(m.state.entries[2]).toMatchObject({ notice: { text: 'Interrupted.' } });
    expect(m.state.entries[4]).toMatchObject({ notice: { level: 'error' } });
    expect(m.state.running).toBe(false);
  });

  it('discards a failed attempt on turn_retry', () => {
    const m = new SessionModel(snapshot());
    feed(m, [
      { type: 'run_start', runId: 'r', input: 'x' },
      { type: 'context', usedTokens: 100, windowTokens: 1000, ratio: 0.1, breakdown: {} as never },
      { type: 'text_delta', text: 'broken' },
      { type: 'turn_retry', attempt: 1, maxAttempts: 3, delayMs: 10, message: 'overloaded' },
      { type: 'text_delta', text: 'good' },
    ]);
    expect(m.state.live.text).toBe('good');
    expect(m.state.context).toMatchObject({ ratio: 0.1 });
  });

  it('keeps committed entry identity while the live region streams', () => {
    const m = new SessionModel(snapshot());
    feed(m, [
      { type: 'run_start', runId: 'r', input: 'x' },
      { type: 'text_delta', text: 'a' },
    ]);
    const first = m.state.entries[0];
    feed(m, [{ type: 'text_delta', text: 'b' }]);
    expect(m.state.entries[0]).toBe(first);
  });

  it('opened mid-ask: updates the snapshot tool card instead of duplicating it', () => {
    const m = new SessionModel(
      snapshot({
        running: true,
        lastSeq: 10,
        transcript: [
          { type: 'message', ts: 1, message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
          {
            type: 'message',
            ts: 2,
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'write', input: {} }] },
          },
        ],
      }),
    );
    feed(m, [
      { type: 'tool_call_start', id: 'w1', name: 'write', input: {} },
      { type: 'tool_call_end', id: 'w1', name: 'write', result: { content: 'ok' } },
      { type: 'text_delta', text: 'done' },
      { type: 'run_end', runId: 'r', stopReason: 'end_turn', usage, sessionUsage: usage },
    ]);
    const tools = m.state.entries.flatMap((e) => (e.kind === 'assistant' ? e.tools : []));
    expect(tools).toMatchObject([{ id: 'w1', running: false, result: { content: 'ok' } }]);
    expect(m.state.entries.at(-1)).toMatchObject({ kind: 'assistant', text: 'done', tools: [] });
  });

  it('reset() replaces state from a snapshot, pending ask included', () => {
    const m = new SessionModel(snapshot());
    feed(m, [{ type: 'run_start', runId: 'r', input: 'x' }]);
    m.reset(
      snapshot({
        lastSeq: 40,
        running: true,
        pendingAsk: { askId: 'a9', toolName: 'edit', input: {}, reason: '' },
      }),
    );
    expect(m.lastSeq).toBe(40);
    expect(m.state).toMatchObject({ running: true, askId: 'a9', entries: [] });
  });
});

describe('entriesFromTranscript', () => {
  it('rebuilds entries and attaches tool results to their cards', () => {
    const entries = entriesFromTranscript([
      { type: 'message', ts: 1, message: { role: 'user', content: [{ type: 'text', text: 'fix it' }] } },
      {
        type: 'message',
        ts: 2,
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'plan' },
            { type: 'text', text: 'Running tests.' },
            { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'npm test' } },
          ],
        },
      },
      {
        type: 'message',
        ts: 3,
        message: { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'FAIL', isError: true }] },
      },
      { type: 'compaction', ts: 4, tokensBefore: 9000, tokensAfter: 1200 },
      { type: 'message', ts: 5, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
    ]);
    expect(entries.map((e) => e.kind)).toEqual(['user', 'assistant', 'notice', 'assistant']);
    expect(entries.map((e) => e.id)).toEqual([0, 1, 2, 3]);
    expect(entries[1]).toMatchObject({
      thinking: 'plan',
      text: 'Running tests.',
      tools: [{ id: 't1', running: false, result: { content: 'FAIL', isError: true } }],
    });
    expect(entries[2]).toMatchObject({ notice: { kind: 'compaction' } });
  });
});
