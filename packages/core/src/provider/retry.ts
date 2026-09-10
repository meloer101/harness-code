/**
 * Retry timing shared by the transport-level retry in `openai-compat.ts` (the
 * initial fetch) and the turn-level retry in `agent/loop.ts` (a stream that
 * failed mid-flight).
 */

import { ProviderError } from './types.js';

/** Exponential backoff with a little jitter: ~1s, 2s, 4s … capped at 20s. */
export function backoffMs(attempt: number): number {
  const base = Math.min(1_000 * 2 ** attempt, 20_000);
  return base + Math.random() * 250;
}

/** Wait `ms`, or reject with `ProviderError('aborted')` as soon as `signal` trips. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError('aborted', 'Aborted while backing off'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError('aborted', 'Aborted while backing off'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
