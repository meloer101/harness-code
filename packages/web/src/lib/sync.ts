/**
 * `SessionSync` — glue between the socket and the store.
 *
 *  - Keeps one `SessionModel` per opened session and stays subscribed to it,
 *    so sidebar badges and background sessions keep folding.
 *  - Events land in the model immediately (cheap) but are published to the
 *    store at most once per animation frame, all dirty sessions in one
 *    `setState` (opencode's 16 ms flush, docs/web-frontend.md M4).
 *  - On every (re)connect: reload server info + the session list and
 *    resubscribe each session from its `lastSeq` — the server replays the gap
 *    or answers `reset` with a fresh snapshot.
 */

import type { PermissionMode } from '@harness-code/core';
import type { AskDecision, WireEvent } from '@harness-code/protocol';

import { RpcClient, RpcError } from './rpc';
import type { ConnectionStatus, RpcClientOptions } from './rpc';
import { SessionModel } from './sessionModel';
import { useAppStore } from './store';
import type { AppState } from './store';

/** Events that change a session's sidebar badges (running / pending). */
const LIST_EVENTS = new Set<WireEvent['type']>(['run_start', 'run_end', 'run_error', 'ask', 'plan', 'resolved']);
const LIST_REFRESH_MS = 250;

export interface SyncOptions {
  url: string;
  token: string;
  store?: {
    getState(): AppState;
    setState(partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void;
  };
  scheduleFrame?: (fn: () => void) => void;
  createSocket?: RpcClientOptions['createSocket'];
}

export class SessionSync {
  readonly rpc: RpcClient;
  #store: NonNullable<SyncOptions['store']>;
  #scheduleFrame: (fn: () => void) => void;
  #models = new Map<string, SessionModel>();
  #opening = new Map<string, Promise<void>>();
  #dirty = new Set<string>();
  #frameQueued = false;
  #listTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SyncOptions) {
    this.#store = opts.store ?? useAppStore;
    this.#scheduleFrame =
      opts.scheduleFrame ??
      ((fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => fn()) : setTimeout(fn, 16)));
    this.rpc = new RpcClient({
      url: opts.url,
      token: opts.token,
      onEvent: (id, seq, event) => this.#onEvent(id, seq, event),
      onStatus: (status) => this.#onStatus(status),
      ...(opts.createSocket ? { createSocket: opts.createSocket } : {}),
    });
  }

  start(): void {
    this.rpc.connect();
  }

  stop(): void {
    if (this.#listTimer) clearTimeout(this.#listTimer);
    this.rpc.close();
  }

  // -- actions ----------------------------------------------------------------

  /** Load a session (live or from disk) and keep it subscribed. Idempotent. */
  open(id: string): Promise<void> {
    if (this.#models.has(id)) return Promise.resolve();
    const inflight = this.#opening.get(id);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const snapshot = await this.rpc.call('session.open', { id });
        this.#models.set(id, new SessionModel(snapshot));
        this.#publish(id);
        await this.#subscribe(id);
      } catch (err) {
        this.#fail(err);
      } finally {
        this.#opening.delete(id);
      }
    })();
    this.#opening.set(id, p);
    return p;
  }

  async create(opts: { model?: string; mode?: PermissionMode } = {}): Promise<string | null> {
    try {
      const snapshot = await this.rpc.call('session.create', opts);
      // A fresh session's only events before the snapshot are its startup
      // notices (skills, MCP, project memory) — which the snapshot doesn't
      // carry. Subscribe from seq 0 so they replay into the transcript.
      this.#models.set(snapshot.id, new SessionModel({ ...snapshot, lastSeq: 0 }));
      this.#publish(snapshot.id);
      await this.#subscribe(snapshot.id);
      this.#scheduleListRefresh();
      return snapshot.id;
    } catch (err) {
      this.#fail(err);
      return null;
    }
  }

  async send(id: string, text: string): Promise<boolean> {
    try {
      await this.rpc.call('session.send', { id, text });
      return true;
    } catch (err) {
      this.#fail(err);
      return false;
    }
  }

  abort(id: string): Promise<void> {
    return this.#run(this.rpc.call('session.abort', { id }));
  }

  setMode(id: string, mode: PermissionMode): Promise<void> {
    return this.#run(this.rpc.call('session.setMode', { id, mode }));
  }

  answerAsk(sessionId: string, askId: string, decision: AskDecision, feedback?: string): Promise<void> {
    return this.#run(
      this.rpc.call('ask.answer', { sessionId, askId, decision, ...(feedback ? { feedback } : {}) }),
    );
  }

  answerPlan(sessionId: string, planId: string, approved: boolean, feedback?: string): Promise<void> {
    return this.#run(
      this.rpc.call('plan.answer', { sessionId, planId, approved, ...(feedback ? { feedback } : {}) }),
    );
  }

  dismissError(): void {
    this.#store.setState({ error: null });
  }

  // -- internals --------------------------------------------------------------

  async #subscribe(id: string): Promise<void> {
    const model = this.#models.get(id);
    if (!model) return;
    const res = await this.rpc.call('session.subscribe', { id, sinceSeq: model.lastSeq });
    if ('reset' in res) {
      model.reset(res.snapshot);
      this.#publish(id);
    }
  }

  #onEvent(id: string, seq: number, event: WireEvent): void {
    const model = this.#models.get(id);
    if (!model || !model.apply(seq, event)) return;
    this.#publish(id);
    if (LIST_EVENTS.has(event.type)) this.#scheduleListRefresh();
  }

  #onStatus(status: ConnectionStatus): void {
    this.#store.setState({ status });
    if (status === 'open') void this.#onConnected();
  }

  async #onConnected(): Promise<void> {
    try {
      const [info, sessions] = await Promise.all([
        this.rpc.call('server.info'),
        this.rpc.call('session.list'),
      ]);
      this.#store.setState({ info, sessions });
    } catch (err) {
      this.#fail(err);
    }
    for (const id of [...this.#models.keys()]) {
      try {
        await this.#subscribe(id);
      } catch (err) {
        if (err instanceof RpcError && err.code === 'not_found') {
          // The server restarted and dropped the host: reopen it from disk.
          this.#models.delete(id);
          await this.open(id);
        } else {
          this.#fail(err);
        }
      }
    }
  }

  /** Mark a session dirty and publish all dirty sessions on the next frame. */
  #publish(id: string): void {
    this.#dirty.add(id);
    if (this.#frameQueued) return;
    this.#frameQueued = true;
    this.#scheduleFrame(() => this.#flush());
  }

  #flush(): void {
    this.#frameQueued = false;
    if (this.#dirty.size === 0) return;
    const updates: AppState['views'] = {};
    for (const id of this.#dirty) {
      const model = this.#models.get(id);
      if (model) updates[id] = model.state;
    }
    this.#dirty.clear();
    this.#store.setState((s) => ({ views: { ...s.views, ...updates } }));
  }

  #scheduleListRefresh(): void {
    if (this.#listTimer) return;
    this.#listTimer = setTimeout(() => {
      this.#listTimer = null;
      this.rpc.call('session.list').then(
        (sessions) => this.#store.setState({ sessions }),
        () => {
          // Transient — the next connect or event refreshes it.
        },
      );
    }, LIST_REFRESH_MS);
  }

  async #run(p: Promise<unknown>): Promise<void> {
    try {
      await p;
    } catch (err) {
      this.#fail(err);
    }
  }

  #fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.#store.setState({ error: message });
  }
}
