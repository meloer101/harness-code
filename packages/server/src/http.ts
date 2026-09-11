/**
 * Static file serving for the web bundle: `node:http` only, no framework.
 *
 * The bundle is a single-page app, so any path that is not a real file falls
 * back to `index.html` (client-side routing). Static assets carry no data, so
 * they need no token (docs/web.md, "Security", point 4). A locked-down CSP is
 * attached to every response.
 *
 * `resolveStaticDir` follows t3code's approach: prefer a `web` dir sitting next
 * to the running server file (how the bundle ships — `dist-bundle/web/`), then
 * fall back to `packages/web/dist` in the source tree. Neither may exist yet
 * (the web package lands in M3); callers tolerate `undefined`.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * A permissive-enough CSP for a self-hosted SPA that talks to its own origin
 * over WS. `connect-src` allows ws/wss so the socket connects; everything else
 * is same-origin. `style-src 'unsafe-inline'` covers bundlers that inject a
 * `<style>` tag.
 */
const CSP = [
  "default-src 'self'",
  "connect-src 'self' ws: wss:",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "font-src 'self' data:",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export function resolveStaticDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'web'), // bundle: dist-bundle/web, sibling of hc.mjs
    join(here, '..', 'web'), // sibling of the server's dist dir
    join(here, '..', '..', 'web', 'dist'), // source tree: packages/web/dist
  ];
  return candidates.find((dir) => existsSync(dir));
}

export interface StaticHandlerOptions {
  /** Directory the SPA bundle lives in; `undefined` while the web package is unbuilt. */
  staticDir?: string | undefined;
}

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

export function createStaticHandler(opts: StaticHandlerOptions): RequestHandler {
  const staticDir = opts.staticDir ? resolve(opts.staticDir) : undefined;
  const indexPath = staticDir ? join(staticDir, 'index.html') : undefined;

  return (req, res) => {
    void serve(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end('internal error');
    });
  };

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end('method not allowed');
      return;
    }

    if (!staticDir || !indexPath) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
      res.end(UNBUILT_PAGE);
      return;
    }

    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const file = safeJoin(staticDir, urlPath);

    // A real file under the static root → serve it. Otherwise fall back to
    // index.html for client-side routes (but never for asset-looking paths).
    if (file && (await isFile(file))) {
      await sendFile(res, file, req.method === 'HEAD');
      return;
    }
    if (extname(urlPath) !== '' && urlPath !== '/') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (await isFile(indexPath)) {
      await sendFile(res, indexPath, req.method === 'HEAD');
      return;
    }
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
    res.end(UNBUILT_PAGE);
  }
}

/** Join `root` + `urlPath`, refusing anything that escapes `root` (path traversal). */
function safeJoin(root: string, urlPath: string): string | undefined {
  const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const full = resolve(join(root, rel));
  if (full !== root && !full.startsWith(root + sep)) return undefined;
  return full;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Vite fingerprints everything under `assets/`, so those can be cached forever;
 * anything else (index.html above all) must revalidate, or a rebuilt bundle
 * keeps loading the old entry point.
 */
function cacheControl(path: string): string {
  return path.split(sep).includes('assets') ? 'public, max-age=31536000, immutable' : 'no-cache';
}

async function sendFile(res: ServerResponse, path: string, headOnly: boolean): Promise<void> {
  const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': cacheControl(path) });
  if (headOnly) {
    res.end();
    return;
  }
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('end', () => resolvePromise());
    stream.pipe(res);
  });
}

const UNBUILT_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>hc web</title></head>
<body style="font-family: system-ui; padding: 2rem; color: #ddd; background: #111;">
<h1>hc web</h1>
<p>The server is running, but the web UI bundle has not been built yet.</p>
<p>The WebSocket API at <code>/ws</code> is available.</p>
</body></html>`;
