/**
 * `SessionHost` — one live `AgentSession` wrapped for many network clients.
 *
 * It is the server-side analogue of the TUI's `UiStore` (`packages/tui/src/
 * state/bridges.ts`), rewritten for N sockets instead of one terminal:
 *
 *  - **Event log.** Every wire event gets a per-session monotonic `seq` and is
 *    kept in a bounded ring buffer so a reconnecting client can replay the gap
 *    (docs/web.md, "Reconnect and multiple tabs").
 *  - **Delta coalescing.** Consecutive `text_delta` / `thinking_delta` are
 *    buffered and flushed as one event every ~30 ms, and immediately before any
 *    non-delta event — the same rule as `packages/protocol`'s `EventBuffer`,
 *    moved to the server so every socket sees ~30 frames/s (docs/web.md,
 *    "Delta coalescing").
 *  - **Busy flag.** One run at a time: `send` rejects with a `busy` error while
 *    a run is active (docs/web.md, "Topology").
 *  - **Run lifecycle.** `run_start` / `run_end` / `run_error` bracket each run.
 *  - **Pending ask/plan.** Live on the host, not the socket, so a reload
 *    mid-prompt shows the prompt again; the first answer wins and every client
 *    gets `resolved`; abort settles a pending ask/plan as a deny. Parallel
 *    tool calls ask concurrently; those asks queue and are shown one at a time.
 *  - **Slash handling.** `/compact`, `/plan`, and MCP prompts are resolved
 *    server-side so every client behaves the same.
 */

import { randomUUID } from 'node:crypto';

import type {
  AgentEvent,
  AgentSession,
  AgentStopReason,
  Notice,
  PermissionDecision,
  PermissionMode,
  SlashCommandInfo,
  Usage,
} from '@harness-code/core';
import { loadTranscript } from '@harness-code/core';
import type { ServerFrame, SessionSnapshot, WireEvent } from '@harness-code/protocol';

/** The current run's events plus enough history to serve a reconnect gap. */
const RING_CAPACITY = 5000;
/** Delta flush cadence — see docs/web.md, "Delta coalescing". */
const COALESCE_MS = 30;

/** Thrown by `send` when a run is already active. The WS layer maps it to `busy`. */
export class BusyError extends Error {
  constructor() {
    super('a run is already active for this session');
    this.name = 'BusyError';
  }
}

/** Thrown when an RPC names a session that has no live host. The WS layer maps it to `not_found`. */
export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`no live session "${id}"`);
    this.name = 'SessionNotFoundError';
  }
}

interface RingEntry {
  seq: number;
  frame: ServerFrame;
}

interface PendingAsk {
  askId: string;
  toolName: string;
  input: unknown;
  reason: string;
  resolve: (decision: PermissionDecision) => void;
}

interface PendingPlan {
  planId: string;
  title: string;
  body: string;
  resolve: (result: { approved: boolean; feedback?: string }) => void;
}

/** A subscriber's frame sink. Registered on `subscribe`, dropped on disconnect. */
export type Listener = (frame: ServerFrame) => void;

export class SessionHost {
  /** Assigned after `attach`. */
  id = '';

  readonly #agentDir: string;
  #session: AgentSession | undefined;
  #modelRef = '';
  /** Last mode broadcast (or snapshotted) — `mode` events fire only on change. */
  #lastMode: PermissionMode | undefined;

  #seq = 0;
  readonly #ring: RingEntry[] = [];
  readonly #listeners = new Set<Listener>();

  #busy = false;
  #currentRunId: string | undefined;

  /**
   * Outstanding permission asks, oldest first. Parallel tool calls ask
   * concurrently, but clients see one at a time: only the head has been
   * announced (`ask` event / snapshot); the next is announced when it settles.
   */
  readonly #asks: PendingAsk[] = [];
  #pendingPlan: PendingPlan | null = null;

  // Delta coalescing buffer: a run of same-typed deltas awaiting flush.
  #pending: { type: 'text_delta' | 'thinking_delta'; text: string } | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: { agentDir: string }) {
    this.#agentDir = opts.agentDir;
  }

  /** Wire the live session in. Called once, right after `AgentSession.create`. */
  attach(session: AgentSession, modelRef: string): void {
    this.#session = session;
    this.#lastMode = session.mode;
    this.id = session.id;
    this.#modelRef = modelRef;
    // Startup notices (skills, MCP, session-start…) are emitted while
    // `AgentSession.create` runs — before the id is known — so their frames
    // were stamped with an empty sessionId. Backfill it so a replay from seq 0
    // routes them to the right session.
    for (const entry of this.#ring) {
      if (entry.frame.t === 'evt' && entry.frame.sessionId === '') {
        entry.frame = { ...entry.frame, sessionId: this.id };
      }
    }
  }

  #requireSession(): AgentSession {
    if (!this.#session) throw new Error('SessionHost has no session attached');
    return this.#session;
  }

  // -- state accessors (for SessionRegistry.list) ---------------------------

  get running(): boolean {
    return this.#busy;
  }

  /** The ask clients currently see — the head of the queue. */
  get #pendingAsk(): PendingAsk | null {
    return this.#asks[0] ?? null;
  }

  get pending(): boolean {
    return this.#pendingAsk !== null || this.#pendingPlan !== null;
  }

  get lastSeq(): number {
    return this.#seq;
  }

  // -- seams handed to AgentSession.create ----------------------------------

  readonly onAgentEvent = (event: AgentEvent): void => {
    if (event.type === 'text_delta' || event.type === 'thinking_delta') {
      this.#bufferDelta(event.type, event.text);
      return;
    }
    // Any non-delta event flushes the coalesced run first, preserving order.
    this.#emit(event);
  };

  readonly onNotice = (notice: Notice): void => {
    this.#emit({ type: 'notice', notice });
    // The session changes mode on its own too (plan approval → acceptEdits),
    // announcing it only as a notice: turn that into the `mode` event clients
    // key their mode picker on.
    if (notice.kind === 'mode-changed') this.#syncMode();
  };

  /** Broadcast the session's current mode if it differs from the last one sent. */
  #syncMode(): void {
    const mode = this.#session?.mode;
    if (mode === undefined || mode === this.#lastMode) return;
    this.#lastMode = mode;
    this.#emit({ type: 'mode', mode });
  }

  readonly ask = (req: {
    toolName: string;
    input: unknown;
    reason: string;
    signal?: AbortSignal;
  }): Promise<PermissionDecision> =>
    new Promise<PermissionDecision>((resolve) => {
      const askId = randomUUID();
      this.#asks.push({ askId, toolName: req.toolName, input: req.input, reason: req.reason, resolve });
      if (this.#asks.length === 1) this.#announceAsk();
      req.signal?.addEventListener(
        'abort',
        () => {
          const i = this.#asks.findIndex((a) => a.askId === askId);
          if (i === -1) return; // already settled
          if (i === 0) {
            this.#settleAsk('abort', { decision: 'deny', reason: 'Aborted' });
          } else {
            // Never announced — drop it quietly.
            this.#asks.splice(i, 1)[0]!.resolve({ decision: 'deny', reason: 'Aborted' });
          }
        },
        { once: true },
      );
    });

  readonly confirm = (req: { title: string; body: string }): Promise<{ approved: boolean; feedback?: string }> =>
    new Promise<{ approved: boolean; feedback?: string }>((resolve) => {
      const planId = randomUUID();
      this.#pendingPlan = { planId, title: req.title, body: req.body, resolve };
      this.#emit({ type: 'plan', planId, title: req.title, body: req.body });
    });

  // -- human-in-the-loop answers --------------------------------------------

  /** First answer wins; a stale/duplicate `askId` is a no-op. */
  answerAsk(askId: string, decision: 'once' | 'always' | 'deny', feedback?: string): void {
    const p = this.#pendingAsk;
    if (!p || p.askId !== askId) return;
    if (decision === 'always') this.#requireSession().engine.addAllowRule(p.toolName);
    const verdict: PermissionDecision =
      decision === 'deny'
        ? { decision: 'deny', reason: feedback ? `User declined: ${feedback}` : 'User declined' }
        : { decision: 'allow' };
    this.#settleAsk('user', verdict);
  }

  answerPlan(planId: string, approved: boolean, feedback?: string): void {
    const p = this.#pendingPlan;
    if (!p || p.planId !== planId) return;
    this.#pendingPlan = null;
    p.resolve({ approved, ...(feedback ? { feedback } : {}) });
    this.#emit({ type: 'resolved', requestId: planId, by: 'user' });
  }

  /** Settle the head ask, then announce the next queued one (if any). */
  #settleAsk(by: 'user' | 'abort', decision: PermissionDecision): void {
    const p = this.#asks.shift();
    if (!p) return;
    p.resolve(decision);
    this.#emit({ type: 'resolved', requestId: p.askId, by });
    this.#announceAsk();
  }

  #announceAsk(): void {
    const head = this.#pendingAsk;
    if (!head) return;
    this.#emit({ type: 'ask', askId: head.askId, toolName: head.toolName, input: head.input, reason: head.reason });
  }

  // -- control --------------------------------------------------------------

  /**
   * Start a run for `text`. Returns immediately with the run id; events stream
   * asynchronously and the run is bracketed by `run_start` / `run_end` (or
   * `run_error`). Throws `BusyError` if a run is already active.
   */
  send(text: string): { runId: string } {
    if (this.#busy) throw new BusyError();
    const runId = randomUUID();
    this.#busy = true;
    this.#currentRunId = runId;
    this.#emit({ type: 'run_start', runId, input: text });
    void this.#execute(runId, text);
    return { runId };
  }

  async #execute(runId: string, text: string): Promise<void> {
    const session = this.#requireSession();
    try {
      const trimmed = text.trim();
      if (trimmed === '/plan') {
        session.setMode('plan');
        this.#syncMode();
        this.#endRun(runId, { stopReason: 'end_turn' });
        return;
      }
      if (trimmed === '/compact') {
        await session.compactNow();
        this.#endRun(runId, { stopReason: 'end_turn' });
        return;
      }
      let effective = text;
      if (trimmed.startsWith('/')) {
        const expanded = await session.expandSlash(trimmed);
        if (expanded === null) {
          this.#emit({ type: 'run_error', runId, message: `unknown command "${trimmed.split(/\s+/)[0]}"` });
          return;
        }
        effective = expanded;
      }
      const result = await session.runTurn(effective);
      this.#endRun(runId, {
        stopReason: result.stopReason,
        usage: result.usage,
      });
    } catch (err) {
      this.#emit({
        type: 'run_error',
        runId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (this.#currentRunId === runId) this.#currentRunId = undefined;
      this.#busy = false;
    }
  }

  #endRun(runId: string, opts: { stopReason: AgentStopReason; usage?: Usage }): void {
    const session = this.#requireSession();
    const emptyUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    this.#emit({
      type: 'run_end',
      runId,
      stopReason: opts.stopReason,
      usage: opts.usage ?? emptyUsage,
      sessionUsage: session.sessionUsage ?? opts.usage ?? emptyUsage,
    });
  }

  /** Abort the in-flight run; settle any pending ask/plan as a deny. */
  abort(): void {
    // Queued asks were never announced: settle them silently, then the head.
    for (const queued of this.#asks.splice(1)) queued.resolve({ decision: 'deny', reason: 'Aborted' });
    if (this.#pendingAsk) this.#settleAsk('abort', { decision: 'deny', reason: 'Aborted' });
    if (this.#pendingPlan) {
      const p = this.#pendingPlan;
      this.#pendingPlan = null;
      p.resolve({ approved: false });
      this.#emit({ type: 'resolved', requestId: p.planId, by: 'abort' });
    }
    this.#session?.abort();
  }

  setMode(mode: PermissionMode): void {
    this.#requireSession().setMode(mode);
    this.#syncMode();
  }

  async compact(): Promise<{ tokensBefore: number; tokensAfter: number } | null> {
    return this.#requireSession().compactNow();
  }

  slashCommands(): SlashCommandInfo[] {
    return this.#requireSession().listSlashCommands();
  }

  // -- subscribe / replay ---------------------------------------------------

  addListener(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * True if the ring still covers every event after `sinceSeq`, so the gap can
   * be replayed without a full reset.
   */
  canReplay(sinceSeq: number): boolean {
    if (sinceSeq === this.#seq) return true; // exactly caught up — nothing to replay
    // Client ahead of us: this host was resurrected from disk (its `seq` restarts
    // at 0) while the client still holds a higher `sinceSeq`. It must reset.
    if (sinceSeq > this.#seq) return false;
    const oldest = this.#ring[0];
    if (!oldest) return false; // events were produced but the ring is empty
    return oldest.seq <= sinceSeq + 1;
  }

  /** Buffered frames with `seq > sinceSeq`, oldest first. */
  since(sinceSeq: number): ServerFrame[] {
    return this.#ring.filter((e) => e.seq > sinceSeq).map((e) => e.frame);
  }

  async snapshot(): Promise<SessionSnapshot> {
    const session = this.#requireSession();
    const snapshot: SessionSnapshot = {
      id: this.id,
      modelRef: this.#modelRef,
      mode: session.mode,
      transcript: await this.#loadTranscript(),
      running: this.#busy,
      lastSeq: this.#seq,
    };
    if (session.sessionUsage) snapshot.usage = session.sessionUsage;
    if (session.contextSnapshot) snapshot.context = session.contextSnapshot;
    if (this.#pendingAsk) {
      snapshot.pendingAsk = {
        askId: this.#pendingAsk.askId,
        toolName: this.#pendingAsk.toolName,
        input: this.#pendingAsk.input,
        reason: this.#pendingAsk.reason,
      };
    }
    if (this.#pendingPlan) {
      snapshot.pendingPlan = {
        planId: this.#pendingPlan.planId,
        title: this.#pendingPlan.title,
        body: this.#pendingPlan.body,
      };
    }
    return snapshot;
  }

  async #loadTranscript(): Promise<SessionSnapshot['transcript']> {
    try {
      return await loadTranscript(this.#agentDir, this.id);
    } catch {
      // No on-disk record yet (recorder disabled, or nothing sent) — fall back
      // to the live model history so a fresh session still snapshots cleanly.
      return this.#requireSession().messages.map((message) => ({
        type: 'message' as const,
        ts: 0,
        message,
      }));
    }
  }

  // -- teardown -------------------------------------------------------------

  async close(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = null;
    this.#listeners.clear();
    await this.#session?.close();
  }

  // -- event pipeline -------------------------------------------------------

  #bufferDelta(type: 'text_delta' | 'thinking_delta', text: string): void {
    if (this.#pending && this.#pending.type === type) {
      this.#pending.text += text;
    } else {
      // A type switch (thinking → text) flushes the previous run first.
      if (this.#pending) this.#flushDeltas();
      this.#pending = { type, text };
    }
    if (!this.#timer) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#flushDeltas();
      }, COALESCE_MS);
    }
  }

  #flushDeltas(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    this.#push({ type: pending.type, text: pending.text });
  }

  /** Emit a non-delta wire event, flushing any coalesced deltas ahead of it. */
  #emit(event: WireEvent): void {
    this.#flushDeltas();
    this.#push(event);
  }

  #push(event: WireEvent): void {
    const seq = ++this.#seq;
    const frame: ServerFrame = { t: 'evt', sessionId: this.id, seq, event };
    this.#ring.push({ seq, frame });
    if (this.#ring.length > RING_CAPACITY) this.#ring.shift();
    for (const listener of this.#listeners) listener(frame);
  }
}
