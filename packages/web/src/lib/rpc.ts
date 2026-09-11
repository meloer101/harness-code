/**
 * `RpcClient` — the one WebSocket per tab (docs/web.md, "Transport").
 *
 *  - **Auth.** The first frame is `auth { token }`; the socket is `open` only
 *    once the server accepts it. A rejected token (close code 4001) is final —
 *    no reconnect loop against a server that will never let us in.
 *  - **Calls.** `call(method, params)` is typed from the protocol's method
 *    table. Calls made while disconnected wait for the next `open`; calls in
 *    flight when the socket drops reject, since we can't know if they ran.
 *  - **Reconnect.** Backoff 0.5/1/2/4/8 s, capped; `wake()` (wired to
 *    `visibilitychange` / `online`) skips the wait, t3code-style.
 *  - **Events.** `{ t: 'evt' }` frames go to `onEvent`; resubscribing after a
 *    reconnect is the caller's job (it knows each session's `lastSeq`).
 */

import type {
  Call,
  ErrorCode,
  MethodName,
  MethodParams,
  MethodResult,
  ServerFrame,
  WireEvent,
} from '@harness-code/protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'unauthorized' | 'closed';

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
const CLOSE_UNAUTHORIZED = 4001;

export class RpcError extends Error {
  constructor(
    readonly code: ErrorCode | 'disconnected',
    message: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** The subset of the DOM `WebSocket` we use — lets tests inject a fake. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface RpcClientOptions {
  url: string;
  token: string;
  onEvent: (sessionId: string, seq: number, event: WireEvent) => void;
  onStatus?: (status: ConnectionStatus) => void;
  createSocket?: (url: string) => SocketLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class RpcClient {
  #opts: RpcClientOptions;
  #socket: SocketLike | null = null;
  #status: ConnectionStatus = 'closed';
  #nextId = 1;
  #authId = 0;
  #inflight = new Map<number, Pending>();
  /** Calls made while not `open`: sent in order once auth succeeds. */
  #queued: Array<{ id: number; method: string; params: unknown }> = [];
  #attempt = 0;
  #retryTimer: unknown = null;
  #stopped = false;

  constructor(opts: RpcClientOptions) {
    this.#opts = opts;
  }

  get status(): ConnectionStatus {
    return this.#status;
  }

  connect(): void {
    this.#stopped = false;
    this.#open();
  }

  /** Reconnect now instead of waiting out the backoff (tab visible / back online). */
  wake(): void {
    if (this.#status !== 'reconnecting' || this.#retryTimer === null) return;
    this.#clearRetry();
    this.#open();
  }

  close(): void {
    this.#stopped = true;
    this.#clearRetry();
    this.#socket?.close();
    this.#socket = null;
    this.#failInflight();
    this.#rejectQueued(disconnected());
    this.#setStatus('closed');
  }

  call: Call = (<M extends MethodName>(method: M, ...args: unknown[]): Promise<MethodResult<M>> => {
    // No-arg methods validate params as `z.void()`: leave the key undefined so
    // JSON drops it, rather than sending `null` (which the schema rejects).
    const params = args[0] as MethodParams<M> | undefined;
    const id = this.#nextId++;
    return new Promise<MethodResult<M>>((resolve, reject) => {
      if (this.#status === 'unauthorized' || this.#stopped) {
        reject(new RpcError('unauthorized', 'not connected'));
        return;
      }
      this.#inflight.set(id, { resolve: resolve as (v: unknown) => void, reject });
      if (this.#status === 'open') this.#send({ t: 'req', id, method, params });
      else this.#queued.push({ id, method, params });
    });
  }) as Call;

  // -- socket lifecycle -------------------------------------------------------

  #open(): void {
    this.#setStatus(this.#attempt === 0 ? 'connecting' : 'reconnecting');
    const socket = (this.#opts.createSocket ?? ((u) => new WebSocket(u) as unknown as SocketLike))(
      this.#opts.url,
    );
    this.#socket = socket;
    socket.onopen = () => {
      this.#authId = this.#nextId++;
      this.#send({ t: 'req', id: this.#authId, method: 'auth', params: { token: this.#opts.token } });
    };
    socket.onmessage = (ev) => {
      if (typeof ev.data === 'string') this.#onFrame(ev.data);
    };
    socket.onerror = () => {
      // `onclose` always follows; handle everything there.
    };
    socket.onclose = (ev) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#failInflight();
      if (this.#stopped) return;
      if (ev.code === CLOSE_UNAUTHORIZED) {
        this.#rejectQueued(new RpcError('unauthorized', 'the server rejected the token'));
        this.#setStatus('unauthorized');
        return;
      }
      this.#scheduleRetry();
    };
  }

  #onFrame(raw: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      return;
    }
    if (frame.t === 'evt') {
      this.#opts.onEvent(frame.sessionId, frame.seq, frame.event);
      return;
    }
    if (frame.id === this.#authId) {
      if (frame.ok) {
        this.#attempt = 0;
        this.#setStatus('open');
        const queued = this.#queued;
        this.#queued = [];
        for (const q of queued) this.#send({ t: 'req', ...q });
      }
      // A failed auth is followed by close(4001) — handled in onclose.
      return;
    }
    const pending = this.#inflight.get(frame.id);
    if (!pending) return;
    this.#inflight.delete(frame.id);
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new RpcError(frame.error.code, frame.error.message));
  }

  #scheduleRetry(): void {
    const delay = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)] ?? 8000;
    this.#attempt++;
    this.#setStatus('reconnecting');
    const set = this.#opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#retryTimer = set(() => {
      this.#retryTimer = null;
      this.#open();
    }, delay);
  }

  #clearRetry(): void {
    if (this.#retryTimer === null) return;
    (this.#opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.#retryTimer);
    this.#retryTimer = null;
  }

  /** Requests already on the wire when the socket died: outcome unknown, reject. */
  #failInflight(): void {
    const queuedIds = new Set(this.#queued.map((q) => q.id));
    for (const [id, p] of this.#inflight) {
      if (queuedIds.has(id)) continue;
      this.#inflight.delete(id);
      p.reject(disconnected());
    }
  }

  #rejectQueued(err: Error): void {
    for (const q of this.#queued) {
      this.#inflight.get(q.id)?.reject(err);
      this.#inflight.delete(q.id);
    }
    this.#queued = [];
  }

  #send(frame: { t: 'req'; id: number; method: string; params: unknown }): void {
    this.#socket?.send(JSON.stringify(frame));
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#opts.onStatus?.(status);
  }
}

function disconnected(): RpcError {
  return new RpcError('disconnected', 'connection lost before the server replied');
}
