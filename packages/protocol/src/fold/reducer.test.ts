import { describe, expect, it } from 'vitest';

import { emptyLive, foldReducer, initialFoldState } from './reducer.js';

function base() {
  return initialFoldState({ mode: 'ask', modelRef: 'm/1' });
}

describe('foldReducer', () => {
  it('FLUSH updates the live region', () => {
    const s = foldReducer(base(), { type: 'FLUSH', live: { thinking: '', text: 'hi', tools: [] } });
    expect(s.live.text).toBe('hi');
  });

  it('USER then TURN_END commits a user + assistant entry and clears live', () => {
    let s = base();
    s = foldReducer(s, { type: 'USER', text: 'hello' });
    s = foldReducer(s, {
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

  it('initialFoldState carries effort, and SET_EFFORT updates it', () => {
    const s0 = initialFoldState({ mode: 'ask', modelRef: 'm/1', effort: 'medium' });
    expect(s0.effort).toBe('medium');
    const s1 = foldReducer(s0, { type: 'SET_EFFORT', effort: 'high' });
    expect(s1.effort).toBe('high');
  });

  it('TURN_END with an empty live region adds no entry', () => {
    const s = foldReducer(base(), { type: 'TURN_END', live: emptyLive() });
    expect(s.entries).toHaveLength(0);
  });

  it('COMMIT_LIVE commits the step and clears live without touching usage', () => {
    let s = base();
    s = foldReducer(s, {
      type: 'TURN_END',
      live: emptyLive(),
      usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 8 },
    });
    s = foldReducer(s, {
      type: 'COMMIT_LIVE',
      live: {
        thinking: 'th',
        text: 'plan',
        tools: [
          {
            id: 't1',
            name: 'exit_plan_mode',
            input: { plan: 'plan' },
            running: false,
            result: { content: 'approved' },
          },
        ],
      },
    });
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({
      kind: 'assistant',
      text: 'plan',
      thinking: 'th',
      tools: [{ name: 'exit_plan_mode', running: false }],
    });
    expect(s.live).toEqual(emptyLive());
    expect(s.usage?.inputTokens).toBe(10);
  });

  it('COMMIT_LIVE with an empty live region adds no entry', () => {
    const s = foldReducer(base(), { type: 'COMMIT_LIVE', live: emptyLive() });
    expect(s.entries).toHaveLength(0);
  });

  it('NOTICE appends a notice entry', () => {
    const s = foldReducer(base(), {
      type: 'NOTICE',
      notice: { kind: 'session-start', level: 'info', text: 'hi' },
    });
    expect(s.entries).toMatchObject([{ kind: 'notice', notice: { text: 'hi' } }]);
  });

  it('SET_MODE updates mode', () => {
    const s = foldReducer(base(), { type: 'SET_MODE', mode: 'plan' });
    expect(s.mode).toBe('plan');
  });

  it('PENDING_ASK / RESOLVE_ASK round-trips', () => {
    let s = base();
    s = foldReducer(s, {
      type: 'PENDING_ASK',
      ask: { toolName: 'bash', input: { command: 'ls' }, reason: 'approve?' },
    });
    expect(s.pendingAsk?.toolName).toBe('bash');
    s = foldReducer(s, { type: 'RESOLVE_ASK' });
    expect(s.pendingAsk).toBeNull();
  });

  it('PENDING_PLAN / RESOLVE_PLAN round-trips', () => {
    let s = base();
    s = foldReducer(s, { type: 'PENDING_PLAN', plan: { title: 't', body: 'b' } });
    expect(s.pendingPlan).toEqual({ title: 't', body: 'b' });
    s = foldReducer(s, { type: 'RESOLVE_PLAN' });
    expect(s.pendingPlan).toBeNull();
  });

  it('NEW_SESSION resets entries and live, keeping mode and modelRef', () => {
    let s = base();
    s = foldReducer(s, { type: 'USER', text: 'x' });
    s = foldReducer(s, { type: 'SET_MODE', mode: 'plan' });
    s = foldReducer(s, { type: 'NEW_SESSION' });
    expect(s.entries).toHaveLength(0);
    expect(s.live).toEqual(emptyLive());
    // NEW_SESSION rebuilds from the *pre-reset* mode/modelRef, so the mode
    // change above survives — only the transcript/live/pending state resets.
    expect(s.mode).toBe('plan');
    expect(s.modelRef).toBe('m/1');
  });
});
