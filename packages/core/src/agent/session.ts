/**
 * Session state and persistence.
 *
 * `SessionState` is the in-memory bit the loop and tools share within one
 * run: which files have been read (the cheap version of Phase 4's file
 * ledger — presence only, no staleness tracking yet) and the current todo
 * list. `SessionRecorder`/`loadSession` are the on-disk side: every message
 * and tool call is appended to `.agent/sessions/<id>.jsonl` as it happens,
 * so a crash loses at most the in-flight turn, and `--resume` (later) can
 * rebuild the message history by replaying the file.
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Message } from '../provider/types.js';
import type { ToolResult } from '../tools/types.js';

// ---------------------------------------------------------------------------
// In-memory session state
// ---------------------------------------------------------------------------

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export class SessionState {
  private readonly readFiles = new Map<string, number>();
  private todos: TodoItem[] = [];

  /** Record that `path` was read, at the mtime it had when read. */
  markRead(path: string, mtimeMs: number): void {
    this.readFiles.set(path, mtimeMs);
  }

  hasRead(path: string): boolean {
    return this.readFiles.has(path);
  }

  setTodos(todos: TodoItem[]): void {
    this.todos = todos;
  }

  getTodos(): TodoItem[] {
    return this.todos;
  }
}

// ---------------------------------------------------------------------------
// On-disk persistence
// ---------------------------------------------------------------------------

export interface SessionEvent {
  type: 'message' | 'tool_call';
  ts: number;
  message?: Message;
  toolCall?: { id: string; name: string; input: unknown; result: ToolResult };
}

export const SESSIONS_DIR = 'sessions';

export function sessionPath(agentDir: string, id: string): string {
  return join(agentDir, SESSIONS_DIR, `${id}.jsonl`);
}

/** Appends session events as they happen. One instance per run. */
export class SessionRecorder {
  readonly id: string;
  private readonly path: string;

  constructor(agentDir: string, id: string = randomUUID()) {
    this.id = id;
    this.path = sessionPath(agentDir, id);
  }

  async recordMessage(message: Message): Promise<void> {
    await this.append({ type: 'message', ts: Date.now(), message });
  }

  async recordToolCall(toolCall: {
    id: string;
    name: string;
    input: unknown;
    result: ToolResult;
  }): Promise<void> {
    await this.append({ type: 'tool_call', ts: Date.now(), toolCall });
  }

  private async append(event: SessionEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, 'utf8');
  }
}

/** Rebuilds the message history for `--resume` by replaying `message` events. */
export async function loadSession(agentDir: string, id: string): Promise<Message[]> {
  const raw = await readFile(sessionPath(agentDir, id), 'utf8');
  const messages: Message[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const event = JSON.parse(line) as SessionEvent;
    if (event.type === 'message' && event.message) messages.push(event.message);
  }
  return messages;
}
