/**
 * Session state and persistence.
 *
 * `SessionState` is the in-memory bit the loop and tools share within one
 * run: which files have been read (the cheap version of Phase 4's file
 * ledger — presence only, no staleness tracking yet) and the current todo
 * list. `SessionRecorder`/`loadSession` are the on-disk side: every message
 * and tool call is appended to `.agent/sessions/<id>.jsonl` as it happens,
 * so a crash loses at most the in-flight turn, and `--resume` rebuilds the
 * message history *and* the read ledger by replaying the file — a resumed
 * session that already read a file last time shouldn't have to read it
 * again just to satisfy the read-before-edit invariant.
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { assertInsideWorkspace } from '../permissions/paths.js';
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

export interface CompactionMeta {
  tokensBefore: number;
  tokensAfter: number;
  keptTurns: number;
}

export interface SessionEvent {
  type: 'message' | 'tool_call' | 'compaction';
  ts: number;
  message?: Message;
  toolCall?: { id: string; name: string; input: unknown; result: ToolResult };
  /** The full post-compaction message list plus what it saved. Replayed by `loadSession`. */
  compaction?: CompactionMeta & { messages: Message[] };
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

  /**
   * Record that history was compacted. Stores the full post-compaction snapshot
   * so `--resume` can pick up the compacted form directly rather than trying to
   * re-derive it.
   */
  async recordCompaction(messages: Message[], meta: CompactionMeta): Promise<void> {
    await this.append({
      type: 'compaction',
      ts: Date.now(),
      compaction: { messages, ...meta },
    });
  }

  private async append(event: SessionEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, 'utf8');
  }
}

async function readSessionEvents(agentDir: string, id: string): Promise<SessionEvent[]> {
  const raw = await readFile(sessionPath(agentDir, id), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as SessionEvent);
}

/**
 * Rebuilds the message history for `--resume`. Replays `message` events, but if
 * the session was ever compacted, starts from the last compaction snapshot and
 * replays only the `message` events recorded after it — so a resumed session
 * continues in the compacted form, not the full pre-compaction history.
 */
export async function loadSession(agentDir: string, id: string): Promise<Message[]> {
  const events = await readSessionEvents(agentDir, id);

  let lastCompaction = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'compaction') {
      lastCompaction = i;
      break;
    }
  }

  const messagesFrom = (slice: SessionEvent[]): Message[] =>
    slice.filter((e) => e.type === 'message' && e.message).map((e) => e.message as Message);

  if (lastCompaction === -1) return messagesFrom(events);

  const snapshot = events[lastCompaction]?.compaction?.messages ?? [];
  return [...snapshot, ...messagesFrom(events.slice(lastCompaction + 1))];
}

const FILE_TOOLS = new Set(['read', 'write', 'edit']);

/**
 * Rebuilds the read ledger for `--resume` by replaying recorded `read` /
 * `write` / `edit` calls that succeeded, marking each touched file as read
 * so the resumed session doesn't re-trip the read-before-edit invariant for
 * files it already touched. Each file is re-`stat`ed at rebuild time rather
 * than trusting the recorded mtime, so a file deleted since the last run is
 * correctly left unmarked — the next edit attempt will require a fresh read.
 */
export async function rebuildSessionState(
  agentDir: string,
  id: string,
  cwd: string,
): Promise<SessionState> {
  const session = new SessionState();
  const events = await readSessionEvents(agentDir, id);
  for (const event of events) {
    if (event.type !== 'tool_call' || !event.toolCall) continue;
    const { name, input, result } = event.toolCall;
    if (!FILE_TOOLS.has(name) || result.isError) continue;
    const rawPath = (input as { path?: unknown }).path;
    if (typeof rawPath !== 'string') continue;
    try {
      const path = await assertInsideWorkspace(cwd, rawPath);
      const stats = await stat(path);
      session.markRead(path, stats.mtimeMs);
    } catch {
      // Path escaped the workspace, or the file no longer exists — leave it
      // unmarked; a genuine edit attempt will correctly ask for a fresh read.
    }
  }
  return session;
}
