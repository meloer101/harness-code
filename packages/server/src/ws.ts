/**
 * The WebSocket transport: one socket per browser tab carrying both RPC and
 * the event stream (docs/web.md, "Transport"). This module owns three things:
 *
 *  - **Handshake security.** Before the HTTP upgrade completes, the `Origin`
 *    must match the server's own origin and the `Host` header must be a
 *    loopback `host:port` — a browser page on any other origin, and a DNS-
 *    rebinding attempt, are both refused here (docs/web.md, "Security" 3).
 *  - **Auth.** The first frame on every socket must be `auth` carrying the
 *    per-server token, compared with `timingSafeEqual`. Anything else closes
 *    the socket.
 *  - **RPC dispatch + subscribe.** Client frames are validated with the exact
 *    zod schemas from `@harness-code/protocol`'s method table, dispatched to
 *    the registry/host, and answered. `session.subscribe` either replays the
 *    gap since `sinceSeq` from the host ring or answers `{ reset, snapshot }`.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import type {
  ClientFrame,
  ErrorCode,
  MethodName,
  MethodParams,
  ServerFrame,
  ServerInfo,
} from '@harness-code/protocol';
import { methods } from '@harness-code/protocol';
import { WebSocket, WebSocketServer } from 'ws';

import { BusyError, SessionNotFoundError } from './host.js';
import type { SessionHost } from './host.js';
import type { SessionRegistry } from './registry.js';

export interface WsServerOptions {
  httpServer: HttpServer;
  registry: SessionRegistry;
  /** The per-server secret; the first frame must present it. */
  token: string;
  /** Exact `Origin` values allowed to upgrade (own origin, plus any dev origin). */
  allowedOrigins: ReadonlySet<string>;
  /** Allowed `Host` header values — loopback `host:port` only. */
  allowedHosts: ReadonlySet<string>;
  /** Computes the `server.info` payload lazily (settings can change on disk). */
  serverInfo: () => Promise<ServerInfo> | ServerInfo;
  /** Upgrade path. Defaults to `/ws`. */
  path?: string;
}

/**
 * Attach a WebSocket server to `httpServer`, handling the upgrade ourselves so
 * we can reject a bad `Origin`/`Host` before the socket is even created. Returns
 * the `WebSocketServer` so the caller can close it on shutdown.
 */
export function attachWsServer(opts: WsServerOptions): WebSocketServer {
  const { httpServer } = opts;
  const path = opts.path ?? '/ws';
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // A peer that resets a rejected upgrade would otherwise raise an unhandled
    // 'error' on this raw socket and crash the process — swallow it.
    socket.on('error', () => {});

    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== path) {
      socket.destroy();
      return;
    }
    if (!originOk(req, opts.allowedOrigins) || !hostOk(req, opts.allowedHosts)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  };
  httpServer.on('upgrade', onUpgrade);
  wss.once('close', () => httpServer.off('upgrade', onUpgrade));

  wss.on('connection', (ws: WebSocket) => {
    new Connection(ws, opts);
  });

  return wss;
}

/** Exact-match the `Origin` header against the allow set (a missing Origin is refused). */
function originOk(req: IncomingMessage, allowed: ReadonlySet<string>): boolean {
  const origin = req.headers.origin;
  return typeof origin === 'string' && allowed.has(origin);
}

/** The `Host` header must be one of the loopback `host:port` values we bound. */
function hostOk(req: IncomingMessage, allowed: ReadonlySet<string>): boolean {
  const host = req.headers.host;
  return typeof host === 'string' && allowed.has(host);
}

/** Constant-time token comparison that never throws on a length mismatch. */
function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** WS close code for a failed/absent auth. 4001 is an app-defined code (>= 4000). */
const CLOSE_UNAUTHORIZED = 4001;

/**
 * One client socket. Tracks auth state and this socket's per-session event
 * subscriptions; every subscription is torn down when the socket closes (the
 * host itself lives on — sessions survive a disconnect, docs/web.md).
 */
class Connection {
  #authed = false;
  readonly #subs = new Map<string, () => void>();

  constructor(
    private readonly ws: WebSocket,
    private readonly opts: WsServerOptions,
  ) {
    ws.on('message', (data: Buffer) => {
      void this.#onMessage(data.toString());
    });
    ws.on('close', () => {
      for (const unsub of this.#subs.values()) unsub();
      this.#subs.clear();
    });
    // A socket-level error just means the peer went away; teardown runs on 'close'.
    ws.on('error', () => {});
  }

  async #onMessage(raw: string): Promise<void> {
    let frame: ClientFrame;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isClientFrame(parsed)) throw new Error('bad frame');
      frame = parsed;
    } catch {
      // Unparseable / malformed frame: nothing to reply to. Close the socket.
      this.ws.close();
      return;
    }

    if (!this.#authed) {
      this.#handleAuth(frame);
      return;
    }
    await this.#dispatch(frame);
  }

  /** The first frame must be `auth { token }`; anything else, or a bad token, closes the socket. */
  #handleAuth(frame: ClientFrame): void {
    if (frame.method !== 'auth') {
      this.#replyError(frame.id, 'unauthorized', 'the first frame must be "auth"');
      this.ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
      return;
    }
    const params = frame.params as { token?: unknown } | null;
    const token = params && typeof params.token === 'string' ? params.token : '';
    if (!tokensEqual(token, this.opts.token)) {
      this.#replyError(frame.id, 'unauthorized', 'invalid token');
      this.ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
      return;
    }
    this.#authed = true;
    this.#replyOk(frame.id, { ok: true });
  }

  async #dispatch(frame: ClientFrame): Promise<void> {
    if (frame.method === 'session.subscribe') {
      await this.#subscribe(frame);
      return;
    }
    if (frame.method === 'session.unsubscribe') {
      this.#unsubscribe(frame);
      return;
    }

    const spec = methods[frame.method as MethodName];
    if (!spec) {
      this.#replyError(frame.id, 'bad_request', `unknown method "${frame.method}"`);
      return;
    }
    const parsed = spec.params.safeParse(frame.params);
    if (!parsed.success) {
      this.#replyError(frame.id, 'bad_request', `invalid params: ${parsed.error.message}`);
      return;
    }
    try {
      const result = await this.#invoke(frame.method as MethodName, parsed.data);
      this.#replyOk(frame.id, result);
    } catch (err) {
      const { code, message } = mapError(err);
      this.#replyError(frame.id, code, message);
    }
  }

  #invoke(method: MethodName, params: unknown): Promise<unknown> | unknown {
    const { registry } = this.opts;
    switch (method) {
      case 'server.info':
        return this.opts.serverInfo();
      case 'session.list':
        return registry.list();
      case 'session.create':
        return registry.create(params as MethodParams<'session.create'>);
      case 'session.open':
        return registry.open(params as MethodParams<'session.open'>);
      case 'session.unsubscribe':
      case 'session.subscribe':
        // Handled before dispatch; unreachable.
        throw new Error('unreachable');
      case 'session.send': {
        const { id, text } = params as MethodParams<'session.send'>;
        return this.#host(id).send(text);
      }
      case 'session.abort': {
        const { id } = params as MethodParams<'session.abort'>;
        this.#host(id).abort();
        return undefined;
      }
      case 'session.setMode': {
        const { id, mode } = params as MethodParams<'session.setMode'>;
        this.#host(id).setMode(mode);
        return undefined;
      }
      case 'session.compact': {
        const { id } = params as MethodParams<'session.compact'>;
        return this.#host(id).compact();
      }
      case 'session.slashCommands': {
        const { id } = params as MethodParams<'session.slashCommands'>;
        return this.#host(id).slashCommands();
      }
      case 'session.close': {
        const { id } = params as MethodParams<'session.close'>;
        return registry.close(id);
      }
      case 'ask.answer': {
        const { sessionId, askId, decision, feedback } = params as MethodParams<'ask.answer'>;
        this.#host(sessionId).answerAsk(askId, decision, feedback);
        return undefined;
      }
      case 'plan.answer': {
        const { sessionId, planId, approved, feedback } = params as MethodParams<'plan.answer'>;
        this.#host(sessionId).answerPlan(planId, approved, feedback);
        return undefined;
      }
      default: {
        const exhaustive: never = method;
        throw new Error(`unhandled method ${String(exhaustive)}`);
      }
    }
  }

  #host(id: string): SessionHost {
    const host = this.opts.registry.get(id);
    if (!host) throw new SessionNotFoundError(id);
    return host;
  }

  // -- subscribe / unsubscribe ----------------------------------------------

  async #subscribe(frame: ClientFrame): Promise<void> {
    const parsed = methods['session.subscribe'].params.safeParse(frame.params);
    if (!parsed.success) {
      this.#replyError(frame.id, 'bad_request', `invalid params: ${parsed.error.message}`);
      return;
    }
    const { id, sinceSeq } = parsed.data;
    const host = this.opts.registry.get(id);
    if (!host) {
      this.#replyError(frame.id, 'not_found', `no live session "${id}"`);
      return;
    }

    // Re-subscribing on the same socket replaces the previous listener.
    this.#subs.get(id)?.();
    this.#subs.delete(id);

    // Fast path: the ring still covers the gap — replay it, no snapshot.
    // Attaching the listener and reading the ring is synchronous, so no event
    // can slip through in between, and replayed (past) frames never overlap
    // with the future frames the listener forwards.
    if (sinceSeq !== undefined && host.canReplay(sinceSeq)) {
      const unsub = host.addListener((f) => this.#sendFrame(f));
      this.#subs.set(id, unsub);
      this.#replyOk(frame.id, { lastSeq: host.lastSeq });
      for (const f of host.since(sinceSeq)) this.#sendFrame(f);
      return;
    }

    // Reset path: snapshot is async, so buffer any events emitted while we
    // build it and flush them (in order, after the reset response) once done —
    // the client always sees the snapshot before the events that follow it.
    const buffer: ServerFrame[] = [];
    let flushing = false;
    const unsub = host.addListener((f) => {
      if (flushing) this.#sendFrame(f);
      else buffer.push(f);
    });
    this.#subs.set(id, unsub);
    const snapshot = await host.snapshot();
    this.#replyOk(frame.id, { reset: true, snapshot });
    flushing = true;
    for (const f of buffer) {
      if (f.t === 'evt' && f.seq > snapshot.lastSeq) this.#sendFrame(f);
    }
  }

  #unsubscribe(frame: ClientFrame): void {
    const parsed = methods['session.unsubscribe'].params.safeParse(frame.params);
    if (!parsed.success) {
      this.#replyError(frame.id, 'bad_request', `invalid params: ${parsed.error.message}`);
      return;
    }
    const { id } = parsed.data;
    this.#subs.get(id)?.();
    this.#subs.delete(id);
    this.#replyOk(frame.id, undefined);
  }

  // -- frame writers --------------------------------------------------------

  #replyOk(id: number, result: unknown): void {
    this.#send({ t: 'res', id, ok: true, result });
  }

  #replyError(id: number, code: ErrorCode, message: string): void {
    this.#send({ t: 'res', id, ok: false, error: { code, message } });
  }

  #sendFrame(frame: ServerFrame): void {
    this.#send(frame);
  }

  #send(frame: ServerFrame): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }
}

function isClientFrame(value: unknown): value is ClientFrame {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Record<string, unknown>;
  return f.t === 'req' && typeof f.id === 'number' && typeof f.method === 'string';
}

/** Map a thrown value to a wire error code. */
function mapError(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof BusyError) return { code: 'busy', message: err.message };
  if (err instanceof SessionNotFoundError) return { code: 'not_found', message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'internal', message };
}
