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
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from '../provider/types.js';
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

  /** The mtime `path` had when it was last read/written this session, or undefined. */
  readMtime(path: string): number | undefined {
    return this.readFiles.get(path);
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
 *
 * Always runs `normalizeHistory` before returning: a kill mid tool-execution
 * leaves assistant `tool_use` without matching `tool_result`, which OpenAI-
 * compatible endpoints reject with 400.
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

  if (lastCompaction === -1) return normalizeHistory(messagesFrom(events));

  const snapshot = events[lastCompaction]?.compaction?.messages ?? [];
  return normalizeHistory([...snapshot, ...messagesFrom(events.slice(lastCompaction + 1))]);
}

/**
 * Make resumed history valid for providers that require every assistant
 * `tool_use` to be followed by a matching `tool_result`:
 * - missing results → synthetic `{ content: 'aborted', isError: true }`
 * - orphan results (no matching tool_use) → dropped
 * - user messages left empty after orphan cleanup → dropped
 */
export function normalizeHistory(messages: readonly Message[]): Message[] {
  const out: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    if (msg.role === 'assistant') {
      out.push(msg);
      const toolUses = msg.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      if (toolUses.length === 0) continue;

      const needed = new Set(toolUses.map((t) => t.id));
      const next = messages[i + 1];
      if (next?.role === 'user') {
        // Consume the following user message here so orphan cleanup runs once.
        i++;
        const kept: ContentBlock[] = [];
        const covered = new Set<string>();
        for (const block of next.content) {
          if (block.type === 'tool_result') {
            if (!needed.has(block.toolUseId)) continue; // orphan
            covered.add(block.toolUseId);
            kept.push(block);
          } else {
            kept.push(block);
          }
        }
        for (const id of needed) {
          if (!covered.has(id)) kept.push(abortedResult(id));
        }
        if (kept.length > 0) out.push({ role: 'user', content: kept });
      } else {
        // Kill mid-tools: assistant is last (or followed by another assistant).
        out.push({
          role: 'user',
          content: toolUses.map((t) => abortedResult(t.id)),
        });
      }
      continue;
    }

    // Lone user message (no preceding assistant handled above): drop orphan
    // tool_results; keep text. Empty → skip.
    const kept: ContentBlock[] = [];
    for (const block of msg.content) {
      if (block.type === 'tool_result') continue; // orphan — no open tool_use
      kept.push(block);
    }
    if (kept.length > 0) out.push({ role: 'user', content: kept });
  }

  return out;
}

function abortedResult(toolUseId: string): ToolResultBlock {
  return {
    type: 'tool_result',
    toolUseId,
    content: 'aborted',
    isError: true,
  };
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

/**
 * Every session id under `.agent/sessions`, with its file mtime, newest first.
 * Mirrors `listTraceIds` in `telemetry/trace.ts`, for `/resume` and `hc …` lists.
 */
export async function listSessionIds(
  agentDir: string,
): Promise<{ id: string; mtimeMs: number }[]> {
  const { readdir, stat: statPath } = await import('node:fs/promises');
  let names: string[];
  try {
    names = await readdir(join(agentDir, SESSIONS_DIR));
  } catch {
    return []; // No sessions dir yet.
  }
  const out: { id: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    try {
      const s = await statPath(sessionPath(agentDir, id));
      out.push({ id, mtimeMs: s.mtimeMs });
    } catch {
      // Vanished between readdir and stat — skip.
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
