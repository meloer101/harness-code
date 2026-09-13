import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionState } from '../agent/session.js';
import type { ToolContext } from './types.js';
import { webfetchTool } from './webfetch.js';

const ctx: ToolContext = { cwd: '/tmp', session: new SessionState() };

function htmlResponse(body: string, contentType = 'text/html'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('webfetchTool', () => {
  it('fetches HTML and returns cleaned markdown with an untrusted-content banner', async () => {
    const fetchMock = vi.fn(async () => htmlResponse('<title>T</title><body><h1>Hi</h1><p>Body</p></body>'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await webfetchTool.execute({ url: 'https://example.com/a' }, ctx);
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain('untrusted external data');
    expect(res.content).toContain('# Hi');
    expect(res.content).toContain('Body');
  });

  it('upgrades http to https before fetching', async () => {
    const fetchMock = vi.fn((_input: string | URL, _init?: RequestInit) =>
      Promise.resolve(htmlResponse('<p>ok</p>')),
    );
    vi.stubGlobal('fetch', fetchMock);

    await webfetchTool.execute({ url: 'http://example.com/x' }, ctx);
    const calledUrl = fetchMock.mock.calls[0]?.[0];
    expect(String(calledUrl)).toBe('https://example.com/x');
  });

  it('refuses a loopback / metadata address without hitting the network', async () => {
    const fetchMock = vi.fn(async () => htmlResponse('<p>secret</p>'));
    vi.stubGlobal('fetch', fetchMock);

    const local = await webfetchTool.execute({ url: 'http://localhost:8080/' }, ctx);
    const meta = await webfetchTool.execute({ url: 'http://169.254.169.254/latest/meta-data' }, ctx);

    expect(local.isError).toBe(true);
    expect(meta.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a cross-host redirect target instead of following it', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.test/steal' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await webfetchTool.execute({ url: 'https://example.com/go' }, ctx);
    expect(res.content).toContain('evil.test/steal');
    expect(res.content).toContain('not followed automatically');
    expect(fetchMock).toHaveBeenCalledTimes(1); // did NOT follow
  });

  it('follows a same-host redirect', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: 'https://example.com/final' } }))
      .mockResolvedValueOnce(htmlResponse('<p>arrived</p>'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await webfetchTool.execute({ url: 'https://example.com/start' }, ctx);
    expect(res.content).toContain('arrived');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('describes a non-text response rather than downloading it', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('binary', { status: 200, headers: { 'content-type': 'image/png', 'content-length': '4096' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await webfetchTool.execute({ url: 'https://example.com/pic.png' }, ctx);
    expect(res.content).toContain('image/png');
    expect(res.content).toContain('not a text page');
  });

  it('pretty-prints a JSON response', async () => {
    const fetchMock = vi.fn(async () => htmlResponse('{"a":1}', 'application/json'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await webfetchTool.execute({ url: 'https://api.example.com/v' }, ctx);
    expect(res.content).toContain('"a": 1');
  });

  it('reports an HTTP error status', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 404, statusText: 'Not Found' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await webfetchTool.execute({ url: 'https://example.com/missing' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('404');
  });
});
