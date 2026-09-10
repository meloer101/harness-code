import { describe, expect, it } from 'vitest';

import { initialTuiState, sessionReducer } from './reducer.js';

function base() {
  return initialTuiState({ mode: 'ask', modelRef: 'm/1', cwd: '/tmp' });
}

describe('sessionReducer (TUI wrapper)', () => {
  it('delegates fold actions to the shared protocol reducer', () => {
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
    expect(s.usage?.inputTokens).toBe(10);
    // TUI-only fields survive a delegated action untouched.
    expect(s.cwd).toBe('/tmp');
  });

  it('OPEN_OVERLAY / CLOSE_OVERLAY sets and clears the overlay', () => {
    let s = base();
    s = sessionReducer(s, { type: 'OPEN_OVERLAY', overlay: 'help' });
    expect(s.overlay).toBe('help');
    s = sessionReducer(s, { type: 'CLOSE_OVERLAY' });
    expect(s.overlay).toBeNull();
  });

  it('TOGGLE_EXPAND flips the output-expansion flag', () => {
    let s = base();
    s = sessionReducer(s, { type: 'TOGGLE_EXPAND' });
    expect(s.expandedOutput).toBe(true);
    s = sessionReducer(s, { type: 'TOGGLE_EXPAND' });
    expect(s.expandedOutput).toBe(false);
  });

  it('NEW_SESSION resets entries/live (shared) and overlay/expandedOutput (TUI-only), keeping cwd', () => {
    let s = base();
    s = sessionReducer(s, { type: 'USER', text: 'x' });
    s = sessionReducer(s, { type: 'OPEN_OVERLAY', overlay: 'resume' });
    s = sessionReducer(s, { type: 'TOGGLE_EXPAND' });
    s = sessionReducer(s, { type: 'NEW_SESSION' });
    expect(s.entries).toHaveLength(0);
    expect(s.overlay).toBeNull();
    expect(s.expandedOutput).toBe(false);
    expect(s.cwd).toBe('/tmp');
  });
});
