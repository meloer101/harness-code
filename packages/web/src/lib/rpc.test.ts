import { describe, expect, it } from 'vitest';

import { RpcClient, RpcError } from './rpc';
import type { ConnectionStatus, SocketLike } from './rpc';

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Array<{ t: string; id: number; method: string; params: unknown }> = [];
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000): void {
    this.onclose?.({ code });
  }
  // test helpers
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  reply(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  last() {
    return this.sent[this.sent.length - 1]!;
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const statuses: ConnectionStatus[] = [];
  const events: unknown[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const client = new RpcClient({
    url: 'ws://test/ws',
    token: 'tok',
    onEvent: (id, seq, event) => events.push({ id, seq, event }),
    onStatus: (s) => statuses.push(s),
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
  });
  const authenticate = (s: FakeSocket) => {
    s.open();
    const auth = s.last();
    expect(auth).toMatchObject({ method: 'auth', params: { token: 'tok' } });
    s.reply({ t: 'res', id: auth.id, ok: true, result: { ok: true } });
  };
  return { client, sockets, statuses, events, timers, authenticate };
}

describe('RpcClient', () => {
  it('sends auth first and only goes open once the server accepts it', () => {
    const { client, sockets, statuses, authenticate } = setup();
    client.connect();
    expect(statuses).toEqual(['connecting']);
    authenticate(sockets[0]!);
    expect(statuses).toEqual(['connecting', 'open']);
  });

  it('queues calls made before auth and resolves them from responses', async () => {
    const { client, sockets, authenticate } = setup();
    client.connect();
    const p = client.call('session.list');
    const s = sockets[0]!;
    expect(s.sent).toHaveLength(0);
    authenticate(s);
    const req = s.last();
    expect(req).toMatchObject({ t: 'req', method: 'session.list' });
    s.reply({ t: 'res', id: req.id, ok: true, result: [] });
    await expect(p).resolves.toEqual([]);
  });

  it('maps error responses to RpcError with the server code', async () => {
    const { client, sockets, authenticate } = setup();
    client.connect();
    authenticate(sockets[0]!);
    const p = client.call('session.send', { id: 'x', text: 'hi' });
    const req = sockets[0]!.last();
    sockets[0]!.reply({ t: 'res', id: req.id, ok: false, error: { code: 'busy', message: 'busy' } });
    await expect(p).rejects.toMatchObject({ code: 'busy' });
    await expect(p).rejects.toBeInstanceOf(RpcError);
  });

  it('forwards event frames', () => {
    const { client, sockets, events, authenticate } = setup();
    client.connect();
    authenticate(sockets[0]!);
    sockets[0]!.reply({ t: 'evt', sessionId: 's1', seq: 3, event: { type: 'mode', mode: 'plan' } });
    expect(events).toEqual([{ id: 's1', seq: 3, event: { type: 'mode', mode: 'plan' } }]);
  });

  it('rejects in-flight calls on disconnect and reconnects with backoff', async () => {
    const { client, sockets, statuses, timers, authenticate } = setup();
    client.connect();
    authenticate(sockets[0]!);
    const p = client.call('session.list');
    sockets[0]!.close(1006);
    await expect(p).rejects.toMatchObject({ code: 'disconnected' });
    expect(statuses.at(-1)).toBe('reconnecting');
    expect(timers.map((t) => t.ms)).toEqual([500]);

    timers[0]!.fn();
    sockets[1]!.close(1006);
    expect(timers.map((t) => t.ms)).toEqual([500, 1000]);

    timers[1]!.fn();
    authenticate(sockets[2]!);
    expect(statuses.at(-1)).toBe('open');
    // Backoff resets after a successful connect.
    sockets[2]!.close(1006);
    expect(timers.at(-1)!.ms).toBe(500);
  });

  it('wake() skips the backoff wait', () => {
    const { client, sockets, authenticate } = setup();
    client.connect();
    authenticate(sockets[0]!);
    sockets[0]!.close(1006);
    expect(sockets).toHaveLength(1);
    client.wake();
    expect(sockets).toHaveLength(2);
  });

  it('stops for good on an unauthorized close', async () => {
    const { client, sockets, statuses, timers } = setup();
    client.connect();
    const p = client.call('server.info');
    const s = sockets[0]!;
    s.open();
    s.reply({ t: 'res', id: s.last().id, ok: false, error: { code: 'unauthorized', message: 'invalid token' } });
    s.close(4001);
    expect(statuses.at(-1)).toBe('unauthorized');
    expect(timers).toHaveLength(0);
    await expect(p).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(client.call('session.list')).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('close() rejects everything and does not reconnect', async () => {
    const { client, sockets, timers } = setup();
    client.connect();
    const queued = client.call('session.list');
    client.close();
    await expect(queued).rejects.toMatchObject({ code: 'disconnected' });
    expect(timers).toHaveLength(0);
    expect(sockets).toHaveLength(1);
  });
});
