/**
 * The network half of `webfetch`: turn a URL into a text body, with the
 * safety envelope a fetch tool needs when a model chooses the destination.
 *
 * Design mirrors Claude Code's WebFetch where it matters for safety:
 *   - only http/https, and http is upgraded to https;
 *   - private / loopback / link-local hosts are refused (SSRF cage, incl. the
 *     cloud metadata endpoint 169.254.169.254);
 *   - same-host redirects are followed (capped, re-checked each hop);
 *   - a cross-host redirect is NOT followed — its target is returned so the
 *     model must re-issue the call, which keeps a redirect from smuggling the
 *     request past an allowlist or the SSRF cage;
 *   - only text-ish content types are read as a body; everything else reports
 *     its type and size instead of being pulled into context;
 *   - the body is size-capped and the request is abortable / timed out.
 *
 * Node 20+ ships a global `fetch`, so there is no HTTP dependency here.
 */

/** Largest response body we will read into memory, in bytes (~5 MB). */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Default per-request timeout. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** How many same-host redirects to follow before giving up. */
const MAX_REDIRECTS = 5;

/** Content types read as a text body. Anything else is described, not downloaded. */
const TEXT_CONTENT_TYPES = [
  'text/',
  'application/json',
  'application/xhtml+xml',
  'application/xml',
  'application/ld+json',
];

export type FetchPageResult =
  | { kind: 'text'; url: string; contentType: string; body: string }
  | { kind: 'redirect'; from: string; to: string }
  | { kind: 'non-text'; url: string; contentType: string; bytes: number | undefined }
  | { kind: 'error'; message: string };

export interface FetchPageOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** A URL is fetchable only over http/https; http is upgraded to https in place. */
function normalizeUrl(raw: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `Not a valid URL: ${raw}` };
  }
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
  } else if (url.protocol !== 'https:') {
    return { error: `Unsupported URL scheme "${url.protocol}" — only http and https are allowed.` };
  }
  return { url };
}

/**
 * Reject hosts that must never be reached from a model-chosen URL: literal
 * localhost, loopback / private / link-local IP literals, and the cloud
 * metadata address. DNS is not resolved here — a hostname that resolves to a
 * private address is out of scope for this cage (a resolving guard would need
 * to pin the connection to the checked address to be sound); this blocks the
 * direct-literal SSRF paths, which is the common case.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true; // loopback, private, "this host"
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
  }
  return false;
}

function isTextContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return TEXT_CONTENT_TYPES.some((t) => ct.startsWith(t));
}

/** Read the response body up to the size cap, aborting the stream once exceeded. */
async function readCappedBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      chunks.push(value);
      if (total >= MAX_BODY_BYTES) {
        await reader.cancel();
        break;
      }
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c.subarray(0, Math.min(c.byteLength, MAX_BODY_BYTES - offset)), offset);
    offset += c.byteLength;
    if (offset >= MAX_BODY_BYTES) break;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged.subarray(0, MAX_BODY_BYTES));
}

/**
 * Fetch a URL into a text body (or a structured non-body result). Never throws
 * for an expected condition — blocked host, bad scheme, cross-host redirect,
 * non-text type, timeout all come back as a tagged `FetchPageResult`.
 */
export async function fetchPage(raw: string, opts: FetchPageOptions = {}): Promise<FetchPageResult> {
  const normalized = normalizeUrl(raw);
  if ('error' in normalized) return { kind: 'error', message: normalized.error };

  let current = normalized.url;
  if (isBlockedHost(current.hostname)) {
    return { kind: 'error', message: `Refusing to fetch a private/loopback address: ${current.hostname}` };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const timer = new AbortController();
    const onAbort = (): void => timer.abort();
    if (opts.signal) {
      if (opts.signal.aborted) return { kind: 'error', message: 'Request aborted.' };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timeout = setTimeout(() => timer.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(current, { redirect: 'manual', signal: timer.signal });
    } catch (err) {
      const aborted = timer.signal.aborted;
      return {
        kind: 'error',
        message: aborted
          ? `Request to ${current.href} timed out after ${timeoutMs}ms.`
          : `Fetch failed for ${current.href}: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timeout);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    }

    // Redirect: only same-host is followed; cross-host is handed back.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        return { kind: 'error', message: `Redirect from ${current.href} had no Location header.` };
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return { kind: 'error', message: `Redirect target is not a valid URL: ${location}` };
      }
      if (next.protocol === 'http:') next.protocol = 'https:';
      if (next.protocol !== 'https:') {
        return { kind: 'error', message: `Redirect to unsupported scheme: ${next.protocol}` };
      }
      if (isBlockedHost(next.hostname)) {
        return { kind: 'error', message: `Redirect points at a private/loopback address: ${next.hostname}` };
      }
      if (next.host !== current.host) {
        return { kind: 'redirect', from: current.href, to: next.href };
      }
      current = next;
      continue;
    }

    if (!res.ok) {
      return { kind: 'error', message: `HTTP ${res.status} ${res.statusText} for ${current.href}` };
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!isTextContentType(contentType)) {
      const len = res.headers.get('content-length');
      return {
        kind: 'non-text',
        url: current.href,
        contentType: contentType || '(unknown)',
        bytes: len ? Number(len) : undefined,
      };
    }

    const body = await readCappedBody(res);
    return { kind: 'text', url: current.href, contentType, body };
  }

  return { kind: 'error', message: `Too many redirects (>${MAX_REDIRECTS}) starting from ${raw}` };
}
