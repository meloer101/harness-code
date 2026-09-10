/**
 * Wire-level frame shapes for the `hc web` WebSocket transport — one socket
 * per tab, carrying both RPC and the event stream. Verbatim from docs/web.md,
 * "Transport".
 */

import type { WireEvent } from './events.js';

/** client → server */
export type ClientFrame = { t: 'req'; id: number; method: string; params: unknown };

/** server → client */
export type ServerFrame =
  | { t: 'res'; id: number; ok: true; result: unknown }
  | { t: 'res'; id: number; ok: false; error: { code: ErrorCode; message: string } }
  | { t: 'evt'; sessionId: string; seq: number; event: WireEvent };

export type ErrorCode = 'unauthorized' | 'not_found' | 'busy' | 'bad_request' | 'internal';