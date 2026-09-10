import { describe, expect, it } from 'vitest';

import { progressOfEvent, progressOfNotice } from './progress.js';

describe('progressOfEvent', () => {
  it('skips token deltas and context snapshots', () => {
    expect(progressOfEvent({ type: 'text_delta', text: 'x' })).toBeUndefined();
    expect(progressOfEvent({ type: 'thinking_delta', text: 'x' })).toBeUndefined();
  });

  it('caps a long tool input summary', () => {
    const line = progressOfEvent(
      { type: 'tool_call_start', id: 'c', name: 'write', input: { content: 'a'.repeat(10_000) } },
      1,
    );
    expect(line?.type).toBe('tool_start');
    const input = line?.input as string;
    expect(input.length).toBeLessThan(1_000);
    expect(input.endsWith('…')).toBe(true);
  });

  it('caps the error text of a failed tool and omits it on success', () => {
    const failed = progressOfEvent(
      { type: 'tool_call_end', id: 'c', name: 'bash', result: { content: 'e'.repeat(2_000), isError: true } },
      1,
    );
    expect((failed?.error as string).length).toBe(501);
    const ok = progressOfEvent({ type: 'tool_call_end', id: 'c', name: 'bash', result: { content: 'fine' } }, 1);
    expect(ok).toEqual({ type: 'tool_end', ts: 1, id: 'c', name: 'bash', is_error: false, output_bytes: 4 });
  });

  it('maps retry, compaction and stop to snake_case', () => {
    expect(
      progressOfEvent({ type: 'turn_retry', attempt: 1, maxAttempts: 2, delayMs: 1500, message: 'drop' }, 1),
    ).toEqual({ type: 'turn_retry', ts: 1, attempt: 1, max_attempts: 2, delay_ms: 1500, message: 'drop' });
    expect(
      progressOfEvent({ type: 'compaction', tokensBefore: 900, tokensAfter: 100, keptTurns: 3 }, 1),
    ).toEqual({ type: 'compaction', ts: 1, tokens_before: 900, tokens_after: 100, kept_turns: 3 });
    expect(progressOfEvent({ type: 'stop', reason: 'max_turns' }, 1)).toEqual({
      type: 'stop',
      ts: 1,
      reason: 'max_turns',
    });
  });
});

describe('progressOfNotice', () => {
  it('carries kind, level and text', () => {
    expect(progressOfNotice({ kind: 'provider-retry', level: 'warn', text: 'retrying' }, 1)).toEqual({
      type: 'notice',
      ts: 1,
      kind: 'provider-retry',
      level: 'warn',
      text: 'retrying',
    });
  });
});
