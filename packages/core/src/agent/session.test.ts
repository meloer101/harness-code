import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { userText } from '../provider/types.js';
import { SessionRecorder, SessionState, loadSession } from './session.js';

describe('SessionState', () => {
  it('tracks which files have been read', () => {
    const session = new SessionState();
    expect(session.hasRead('/a.txt')).toBe(false);
    session.markRead('/a.txt', 123);
    expect(session.hasRead('/a.txt')).toBe(true);
  });

  it('stores the todo list', () => {
    const session = new SessionState();
    expect(session.getTodos()).toEqual([]);
    session.setTodos([{ id: '1', content: 'x', status: 'pending' }]);
    expect(session.getTodos()).toHaveLength(1);
  });
});

describe('SessionRecorder / loadSession', () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await realpath(await mkdtemp(join(tmpdir(), 'hc-session-')));
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  it('replays recorded messages in order', async () => {
    const recorder = new SessionRecorder(agentDir, 'test-session');
    await recorder.recordMessage(userText('hello'));
    await recorder.recordToolCall({
      id: 'call_1',
      name: 'read',
      input: { path: 'a.txt' },
      result: { content: '1\tfoo' },
    });
    await recorder.recordMessage({ role: 'assistant', content: [{ type: 'text', text: 'done' }] });

    const messages = await loadSession(agentDir, 'test-session');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(userText('hello'));
    expect(messages[1]?.role).toBe('assistant');
  });
});
