// @vitest-environment node
/**
 * End to end: the web client's `SessionSync` against a real `hc web --mock`
 * server over a real socket — auth, create, send, the mock's three permission
 * asks, run end — plus a second "tab" that opens the session mid-ask and
 * answers it (pending ask survives a reload; first answer wins for everyone).
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '@harness-code/server';
import type { RunningServer } from '@harness-code/server';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';

import type { SocketLike } from './rpc';
import type { AppState } from './store';
import { SessionSync } from './sync';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function boot(): Promise<{ server: RunningServer; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'hc-web-e2e-'));
  const server = await startServer({ cwd, mock: true });
  cleanups.push(async () => {
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return { server, cwd };
}

function tab(server: RunningServer) {
  const store = createStore<AppState>(() => ({ status: 'closed', info: null, sessions: [], views: {}, error: null }));
  const origin = `http://127.0.0.1:${server.port}`;
  const sync = new SessionSync({
    url: `ws://127.0.0.1:${server.port}/ws`,
    token: server.token,
    store,
    scheduleFrame: (fn) => setTimeout(fn, 0),
    createSocket: (url) => new WebSocket(url, { origin }) as unknown as SocketLike,
  });
  sync.start();
  cleanups.push(() => sync.stop());
  return { sync, store };
}

let debugState: (() => unknown) | undefined;
async function until<T>(read: () => T | undefined | null | false, what: string, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(debugState?.())}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('SessionSync ↔ hc web --mock', () => {
  it('runs a full turn with permission asks, and a second tab can answer', async () => {
    const { server, cwd } = await boot();
    const a = tab(server);
    debugState = () => {
      const s = a.store.getState();
      return { status: s.status, error: s.error };
    };
    await until(() => a.store.getState().info, 'server info');

    const id = await a.sync.create();
    expect(id).toBeTruthy();
    const view = () => a.store.getState().views[id!];
    await until(view, 'initial view');

    expect(await a.sync.send(id!, 'set up a scratch file')).toBe(true);

    // Ask #1 (bash) — answered from tab A.
    const ask1 = await until(() => view()?.askId, 'first ask');
    expect(view()!.pendingAsk?.toolName).toBe('bash');
    await a.sync.answerAsk(id!, ask1, 'once');

    // Ask #2 (write) — a second tab opens the session and sees it pending.
    const ask2 = await until(() => {
      const v = view();
      return v?.askId && v.askId !== ask1 ? v.askId : null;
    }, 'second ask');
    const b = tab(server);
    await b.sync.open(id!);
    const bView = () => b.store.getState().views[id!];
    await until(() => bView()?.askId === ask2, 'tab B sees the pending ask');
    expect(bView()!.pendingAsk?.toolName).toBe('write');
    // The mid-run snapshot carries the turn so far (not just finished turns).
    expect(bView()!.entries[0]).toMatchObject({ kind: 'user', text: 'set up a scratch file' });
    const bTools = () => bView()!.entries.flatMap((e) => (e.kind === 'assistant' ? e.tools : []));
    expect(bTools().map((t) => t.name)).toEqual(['bash', 'write']);
    expect(bTools()[0]!.result?.content).toContain('hello from the hc web mock');
    await b.sync.answerAsk(id!, ask2, 'once');
    await until(() => view()?.askId !== ask2, 'tab A sees ask #2 resolved');

    // Ask #3 (edit) — back on tab A.
    const ask3 = await until(() => {
      const v = view();
      return v?.askId && v.askId !== ask2 ? v.askId : null;
    }, 'third ask');
    await a.sync.answerAsk(id!, ask3, 'once');

    await until(() => view() && !view()!.running && view()!.entries.length >= 5, 'run end');
    const final = view()!;
    expect(final.entries[0]).toMatchObject({ kind: 'user', text: 'set up a scratch file' });
    const tools = final.entries.flatMap((e) => (e.kind === 'assistant' ? e.tools.map((t) => t.name) : []));
    expect(tools).toEqual(['bash', 'write', 'edit']);
    expect(final.entries.at(-1)).toMatchObject({ kind: 'assistant', text: 'All set — the scratch file is ready.' });
    expect(await readFile(join(cwd, 'mock-demo.txt'), 'utf8')).toContain('edited by the mock');

    // Tab B folded the same run from its mid-run snapshot onwards.
    await until(() => bView() && !bView()!.running, 'tab B run end');
    expect(bView()!.entries.at(-1)).toMatchObject({ text: 'All set — the scratch file is ready.' });
    // The write card came from the snapshot; its result arrived as a later event.
    expect(bTools().map((t) => [t.name, t.result !== undefined])).toEqual([
      ['bash', true],
      ['write', true],
      ['edit', true],
    ]);

    // The sidebar list shows the session.
    await until(() => a.store.getState().sessions.some((s) => s.id === id && !s.running), 'session in list');
  });

  it('reports a bad token as unauthorized without retrying', async () => {
    const { server } = await boot();
    const store = createStore<AppState>(() => ({ status: 'closed', info: null, sessions: [], views: {}, error: null }));
    const sync = new SessionSync({
      url: `ws://127.0.0.1:${server.port}/ws`,
      token: 'nope',
      store,
      createSocket: (url) => new WebSocket(url, { origin: `http://127.0.0.1:${server.port}` }) as unknown as SocketLike,
    });
    sync.start();
    cleanups.push(() => sync.stop());
    await until(() => store.getState().status === 'unauthorized', 'unauthorized status');
  });
});
