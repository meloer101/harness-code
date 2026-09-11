import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createStaticHandler } from './http.js';

let dir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hc-static-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>app</title>');
  await writeFile(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  server = createServer(createStaticHandler({ staticDir: dir }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

describe('static handler', () => {
  it('serves index.html with no-cache so rebuilds are picked up', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('caches fingerprinted assets forever', async () => {
    const res = await fetch(`${base}/assets/index-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('falls back to index.html for client routes but 404s missing assets', async () => {
    const route = await fetch(`${base}/some/route`);
    expect(route.status).toBe(200);
    expect(await route.text()).toContain('<title>app</title>');
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
  });
});
