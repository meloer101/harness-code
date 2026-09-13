/**
 * WebSocket integration tests: a real `startServer` bound to 127.0.0.1, driven
 * by the `ws` client. Covers the three handshake/transport guarantees from
 * docs/web.md "Security" — a bad `Origin` never upgrades, a bad token never
 * authenticates — plus one full authed round-trip (create → subscribe → send →
 * event stream).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CAPABILITIES, ScriptedProvider } from '@harness-code/core';
import type { ResolvedModel, ScriptedTurn } from '@harness-code/core';
import type { ServerFrame } from '@harness-code/protocol';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from './index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

function scriptedModel(turns: readonly ScriptedTurn[]): ResolvedModel {
  const provider = new ScriptedProvider(turns);
  return {
    provider,
    providerId: provider.id,
    model: 'test-model',
    ref: `${provider.id}/test-model`,
    capabilities: { ...DEFAULT_CAPABILITIES },
  };
}

async function boot(turns: readonly ScriptedTurn[] = [{ text: 'hi from the server' }]): Promise<RunningServer> {
  const cwd = await mkdtemp(join(tmpdir(), 'hc-ws-'));
  const server = await startServer({
    cwd,
    buildConfig: () =>
      Promise.resolve({
        cwd,
        model: scriptedModel(turns),
        settings: {},
        budgets: {},
        mode: 'yolo',
        skills: false,
        subagents: false,
        mcp: false,
        memory: false,
        recorder: false,
        trace: false,
        projectMemory: null,
      }),
  });
  cleanups.push(async () => {
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return server;
}

/** A thin promise-based client over a `ws` socket. */
class Client {
  private nextId = 1;
  private readonly pending = new Map<number, (frame: ServerFrame) => void>();
  readonly events: ServerFrame[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as ServerFrame;
      if (frame.t === 'evt') {
        this.events.push(frame);
        return;
      }
      this.pending.get(frame.id)?.(frame);
      this.pending.delete(frame.id);
    });
  }

  static open(url: string, origin: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { origin });
      ws.once('open', () => resolve(new Client(ws)));
      ws.once('error', reject);
      ws.once('unexpected-response', () => reject(new Error('unexpected-response')));
    });
  }

  call(method: string, params?: unknown): Promise<ServerFrame> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ t: 'req', id, method, params }));
    });
  }

  onClose(): Promise<number> {
    return new Promise((resolve) => this.ws.once('close', (code) => resolve(code)));
  }

  async waitForEvent(type: string, timeoutMs = 5000): Promise<ServerFrame> {
    const found = this.events.find((f) => f.t === 'evt' && f.event.type === type);
    if (found) return found;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      const check = (): void => {
        const hit = this.events.find((f) => f.t === 'evt' && f.event.type === type);
        if (hit) {
          clearTimeout(timer);
          this.ws.off('message', check);
          resolve(hit);
        }
      };
      this.ws.on('message', check);
    });
  }

  close(): void {
    this.ws.close();
  }
}

function wsUrl(server: RunningServer): string {
  return `ws://127.0.0.1:${server.port}/ws`;
}

describe('ws transport', () => {
  it('refuses the upgrade when the Origin is wrong', async () => {
    const server = await boot();
    await expect(Client.open(wsUrl(server), 'http://evil.example.com')).rejects.toBeTruthy();
  });

  it('closes the socket on a bad auth token', async () => {
    const server = await boot();
    const client = await Client.open(wsUrl(server), `http://127.0.0.1:${server.port}`);
    const closed = client.onClose();
    const res = await client.call('auth', { token: 'not-the-token' });
    expect(res).toMatchObject({ t: 'res', ok: false, error: { code: 'unauthorized' } });
    expect(await closed).toBe(4001);
  });

  it('rejects RPC before auth', async () => {
    const server = await boot();
    const client = await Client.open(wsUrl(server), `http://127.0.0.1:${server.port}`);
    const res = await client.call('session.list');
    expect(res).toMatchObject({ t: 'res', ok: false, error: { code: 'unauthorized' } });
  });

  it('runs a full authed round-trip: create → subscribe → send → events', async () => {
    const server = await boot([{ text: 'hello over the wire', chunkSize: 4 }]);
    const client = await Client.open(wsUrl(server), `http://127.0.0.1:${server.port}`);

    const auth = await client.call('auth', { token: server.token });
    expect(auth).toMatchObject({ t: 'res', ok: true });

    const created = await client.call('session.create', {});
    expect(created).toMatchObject({ t: 'res', ok: true });
    const snapshot = (created as { result: { id: string } }).result;
    expect(typeof snapshot.id).toBe('string');

    const sub = await client.call('session.subscribe', { id: snapshot.id });
    expect(sub).toMatchObject({ t: 'res', ok: true, result: { reset: true } });

    const sent = await client.call('session.send', { id: snapshot.id, text: 'go' });
    expect(sent).toMatchObject({ t: 'res', ok: true });
    expect((sent as { result: { runId: string } }).result.runId).toBeTruthy();

    const runEnd = await client.waitForEvent('run_end');
    expect(runEnd).toMatchObject({ t: 'evt', sessionId: snapshot.id });

    const texts = client.events
      .filter((f) => f.t === 'evt' && f.event.type === 'text_delta')
      .map((f) => (f.t === 'evt' && f.event.type === 'text_delta' ? f.event.text : ''));
    expect(texts.join('')).toBe('hello over the wire');

    client.close();
  });

  it('serves server.info once authed', async () => {
    const server = await boot();
    const client = await Client.open(wsUrl(server), `http://127.0.0.1:${server.port}`);
    await client.call('auth', { token: server.token });
    const info = await client.call('server.info');
    expect(info).toMatchObject({ t: 'res', ok: true });
    const result = (info as { result: { version: string; modes: string[] } }).result;
    expect(result.modes).toContain('plan');
    expect(typeof result.version).toBe('string');
  });
});
