import { describe, expect, it } from 'vitest';

import { emptyLive, initialTuiState, sessionReducer } from './reducer.js';

function base() {
  return initialTuiState({ mode: 'ask', modelRef: 'm/1', cwd: '/tmp' });
}

describe('sessionReducer', () => {
  it('FLUSH updates the live region', () => {
    const s = sessionReducer(base(), {
      type: 'FLUSH',
      live: { thinking: '', text: 'hi', tools: [] },
    });
    expect(s.live.text).toBe('hi');
  });

  it('USER then TURN_END commits a user + assistant entry and clears live', () => {
    let s = base();
    s = sessionReducer(s, { type: 'USER', text: 'hello' });
    s = sessionReducer(s, {
      type: 'TURN_END',
      live: { thinking: 'th', text: 'ans', tools: [] },
      usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 8 },
    });
    expect(s.entries).toHaveLength(2);
    expect(s.entries[0]).toMatchObject({ kind: 'user', text: 'hello' });
    expect(s.entries[1]).toMatchObject({ kind: 'assistant', text: 'ans', thinking: 'th' });
    expect(s.live).toEqual(emptyLive());
    expect(s.usage?.inputTokens).toBe(10);
  });

  it('TURN_END with an empty live region adds no entry', () => {
    const s = sessionReducer(base(), { type: 'TURN_END', live: emptyLive() });
    expect(s.entries).toHaveLength(0);
  });

  it('TOGGLE_EXPAND flips the output-expansion flag', () => {
    let s = base();
    s = sessionReducer(s, { type: 'TOGGLE_EXPAND' });
    expect(s.expandedOutput).toBe(true);
    s = sessionReducer(s, { type: 'TOGGLE_EXPAND' });
    expect(s.expandedOutput).toBe(false);
  });

  it('PENDING_ASK / RESOLVE_ASK round-trips', () => {
    let s = base();
    s = sessionReducer(s, {
      type: 'PENDING_ASK',
      ask: { toolName: 'bash', input: { command: 'ls' }, reason: 'approve?' },
    });
    expect(s.pendingAsk?.toolName).toBe('bash');
    s = sessionReducer(s, { type: 'RESOLVE_ASK' });
    expect(s.pendingAsk).toBeNull();
  });

  it('NEW_SESSION resets entries and live', () => {
    let s = base();
    s = sessionReducer(s, { type: 'USER', text: 'x' });
    s = sessionReducer(s, { type: 'NEW_SESSION' });
    expect(s.entries).toHaveLength(0);
    expect(s.live).toEqual(emptyLive());
  });
});
