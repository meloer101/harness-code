import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { userText } from '../provider/types.js';
import { SessionRecorder, SessionState, loadSession, rebuildSessionState } from './session.js';

describe('SessionState', () => {
  it('tracks which files have been read', () => {
    const session = new SessionState();
    expect(session.hasRead('/a.txt')).toBe(false);
    session.markRead('/a.txt', 123);
    expect(session.hasRead('/a.txt')).toBe(true);
  });

  it('exposes the recorded mtime, or undefined when never read', () => {
    const session = new SessionState();
    expect(session.readMtime('/a.txt')).toBeUndefined();
    session.markRead('/a.txt', 456);
    expect(session.readMtime('/a.txt')).toBe(456);
    session.markRead('/a.txt', 789);
    expect(session.readMtime('/a.txt')).toBe(789);
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

  it('resumes from the last compaction snapshot plus messages recorded after it', async () => {
    const recorder = new SessionRecorder(agentDir, 'test-session');
    await recorder.recordMessage(userText('original goal'));
    await recorder.recordMessage({ role: 'assistant', content: [{ type: 'text', text: 'old turn 1' }] });
    await recorder.recordMessage(userText('old turn 2'));

    const snapshot = [userText('original goal\n---\ndigest'), { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'kept turn' }] }];
    await recorder.recordCompaction(snapshot, { tokensBefore: 5000, tokensAfter: 900, keptTurns: 1 });

    await recorder.recordMessage(userText('post-compaction message'));

    const messages = await loadSession(agentDir, 'test-session');
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual(snapshot[0]);
    expect(messages[1]).toEqual(snapshot[1]);
    expect(messages[2]).toEqual(userText('post-compaction message'));
  });
});

describe('rebuildSessionState', () => {
  let agentDir: string;
  let cwd: string;

  beforeEach(async () => {
    agentDir = await realpath(await mkdtemp(join(tmpdir(), 'hc-session-')));
    // realpath: on macOS, os.tmpdir() is itself a symlink, and
    // assertInsideWorkspace() realpaths everything it resolves — cwd has to
    // be canonical too, or it won't string-match what rebuildSessionState marks.
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'hc-session-cwd-')));
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it('marks files touched by successful read/write/edit calls as read', async () => {
    await writeFile(join(cwd, 'a.txt'), 'hello', 'utf8');
    const recorder = new SessionRecorder(agentDir, 'test-session');
    await recorder.recordToolCall({
      id: 'call_1',
      name: 'read',
      input: { path: 'a.txt' },
      result: { content: '1\thello' },
    });

    const session = await rebuildSessionState(agentDir, 'test-session', cwd);

    expect(session.hasRead(join(cwd, 'a.txt'))).toBe(true);
  });

  it('does not mark a file whose recorded call failed', async () => {
    await writeFile(join(cwd, 'a.txt'), 'hello', 'utf8');
    const recorder = new SessionRecorder(agentDir, 'test-session');
    await recorder.recordToolCall({
      id: 'call_1',
      name: 'edit',
      input: { path: 'a.txt', oldString: 'x', newString: 'y' },
      result: { content: 'oldString not found', isError: true },
    });

    const session = await rebuildSessionState(agentDir, 'test-session', cwd);

    expect(session.hasRead(join(cwd, 'a.txt'))).toBe(false);
  });

  it('does not mark a file that no longer exists', async () => {
    const recorder = new SessionRecorder(agentDir, 'test-session');
    await recorder.recordToolCall({
      id: 'call_1',
      name: 'read',
      input: { path: 'gone.txt' },
      result: { content: '1\thello' },
    });

    const session = await rebuildSessionState(agentDir, 'test-session', cwd);

    expect(session.hasRead(join(cwd, 'gone.txt'))).toBe(false);
  });

  it('ignores tool calls unrelated to the file ledger', async () => {
    const recorder = new SessionRecorder(agentDir, 'test-session');
    await recorder.recordToolCall({
      id: 'call_1',
      name: 'bash',
      input: { command: 'echo hi' },
      result: { content: 'hi' },
    });

    const session = await rebuildSessionState(agentDir, 'test-session', cwd);

    expect(session.getTodos()).toEqual([]); // sanity: a fresh, otherwise-empty session
  });
});
