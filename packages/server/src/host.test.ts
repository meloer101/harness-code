/**
 * `SessionHost` unit tests: a real `AgentSession` driven by a `ScriptedProvider`
 * exercises every host responsibility from docs/web.md — monotonic `seq`, delta
 * coalescing, the busy guard, first-answer-wins asks, abort→deny settlement, and
 * reconnect gap-replay vs. reset.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CAPABILITIES, ScriptedProvider } from '@harness-code/core';
import type { PermissionMode, ResolvedModel, ScriptedTurn } from '@harness-code/core';
import type { ServerFrame, WireEvent } from '@harness-code/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { BusyError, type SessionHost } from './host.js';
import { SessionRegistry } from './registry.js';

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
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

interface Fixture {
  host: SessionHost;
  registry: SessionRegistry;
  frames: ServerFrame[];
  events: () => WireEvent[];
}

async function makeHost(
  turns: readonly ScriptedTurn[],
  opts: { mode?: PermissionMode } = {},
): Promise<Fixture> {
  const cwd = await mkdtemp(join(tmpdir(), 'hc-host-'));
  tmpDirs.push(cwd);
  const registry = new SessionRegistry({
    cwd,
    agentDir: join(cwd, '.agent'),
    buildConfig: () =>
      Promise.resolve({
        cwd,
        model: scriptedModel(turns),
        settings: {},
        budgets: {},
        mode: opts.mode ?? 'yolo',
        skills: false,
        subagents: false,
        mcp: false,
        recorder: false,
        trace: false,
        projectMemory: null,
      }),
  });
  const snapshot = await registry.create({});
  const host = registry.get(snapshot.id);
  if (!host) throw new Error('host not registered after create');

  const frames: ServerFrame[] = [];
  host.addListener((f) => frames.push(f));
  return { host, registry, frames, events: () => frames.flatMap((f) => (f.t === 'evt' ? [f.event] : [])) };
}

/** Resolve once the current run reaches a terminal event. */
function runSettled(host: SessionHost): Promise<WireEvent> {
  return new Promise((resolve) => {
    const unsub = host.addListener((f) => {
      if (f.t === 'evt' && (f.event.type === 'run_end' || f.event.type === 'run_error')) {
        unsub();
        resolve(f.event);
      }
    });
  });
}

/** Resolve with the first event matching `type`. */
function firstEvent<T extends WireEvent['type']>(
  host: SessionHost,
  type: T,
): Promise<Extract<WireEvent, { type: T }>> {
  return new Promise((resolve) => {
    const unsub = host.addListener((f) => {
      if (f.t === 'evt' && f.event.type === type) {
        unsub();
        resolve(f.event as Extract<WireEvent, { type: T }>);
      }
    });
  });
}

describe('SessionHost', () => {
  it('assigns a strictly monotonic seq to every frame', async () => {
    const { host, frames } = await makeHost([{ text: 'hi there' }]);
    const settled = runSettled(host);
    host.send('go');
    await settled;

    const seqs = frames.filter((f) => f.t === 'evt').map((f) => (f as { seq: number }).seq);
    expect(seqs.length).toBeGreaterThan(1);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1]! + 1);
    expect(host.lastSeq).toBe(seqs.at(-1));
  });

  it('coalesces consecutive text deltas into one wire event, in order', async () => {
    const { host, events } = await makeHost([{ text: 'hello world', chunkSize: 1 }]);
    const settled = runSettled(host);
    host.send('go');
    await settled;

    const ev = events();
    const textDeltas = ev.filter((e) => e.type === 'text_delta') as Array<{ text: string }>;
    // The provider emitted 11 single-char deltas; coalescing must collapse them.
    expect(textDeltas.length).toBeLessThan(11);
    expect(textDeltas.map((d) => d.text).join('')).toBe('hello world');

    // Ordering: the coalesced delta is flushed before the run_start's siblings
    // and any later non-delta event (e.g. turn_end / stop).
    const firstDeltaIdx = ev.findIndex((e) => e.type === 'text_delta');
    const stopIdx = ev.findIndex((e) => e.type === 'stop');
    expect(firstDeltaIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeGreaterThan(firstDeltaIdx);
  });

  it('emits run_start before streaming and brackets the run with run_end', async () => {
    const { host, events } = await makeHost([{ text: 'done' }]);
    const settled = runSettled(host);
    const { runId } = host.send('go');
    const end = await settled;

    const ev = events();
    expect(ev[0]).toMatchObject({ type: 'run_start', runId, input: 'go' });
    expect(end).toMatchObject({ type: 'run_end', runId });
  });

  it('rejects a second send while a run is active (busy)', async () => {
    const { host } = await makeHost([{ text: 'a' }, { text: 'b' }]);
    const settled = runSettled(host);
    host.send('first');
    expect(() => host.send('second')).toThrow(BusyError);
    await settled;
    // Once the run settles, the host frees up.
    expect(() => host.send('third')).not.toThrow();
  });

  it('honours the first answer to an ask and ignores the rest (first-answer-wins)', async () => {
    const { host, events } = await makeHost(
      [{ toolCalls: [{ name: 'write', input: { path: 'note.txt', content: 'hi' } }] }, { text: 'done' }],
      { mode: 'ask' },
    );
    const askP = firstEvent(host, 'ask');
    const settled = runSettled(host);
    host.send('go');
    const { askId } = await askP;

    host.answerAsk(askId, 'once');
    host.answerAsk(askId, 'deny'); // stale — must be a no-op
    await settled;

    const resolved = events().filter((e) => e.type === 'resolved') as Array<{ requestId: string; by: string }>;
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ requestId: askId, by: 'user' });
    expect(host.pending).toBe(false);
  });

  it('settles a pending ask as deny on abort and broadcasts resolved{by:abort}', async () => {
    const { host, events } = await makeHost(
      [{ toolCalls: [{ name: 'write', input: { path: 'note.txt', content: 'hi' } }] }, { text: 'done' }],
      { mode: 'ask' },
    );
    const settled = runSettled(host);
    host.send('go');
    await firstEvent(host, 'ask');
    host.abort();
    await settled;

    const resolved = events().filter((e) => e.type === 'resolved') as Array<{ by: string }>;
    expect(resolved.some((r) => r.by === 'abort')).toBe(true);
    expect(host.pending).toBe(false);
  });

  it('stamps startup notices (emitted before attach) with the session id', async () => {
    const { host } = await makeHost([{ text: 'hi' }]);
    const early = host.since(0);
    expect(early.length).toBeGreaterThan(0);
    for (const f of early) expect(f).toMatchObject({ t: 'evt', sessionId: host.id });
  });

  it('queues concurrent asks from parallel tool calls and shows them one at a time', async () => {
    const { host, events } = await makeHost(
      [
        {
          toolCalls: [
            { name: 'write', input: { path: 'a.txt', content: 'a' } },
            { name: 'write', input: { path: 'b.txt', content: 'b' } },
          ],
        },
        { text: 'both written' },
      ],
      { mode: 'ask' },
    );
    const settled = runSettled(host);
    host.send('go');

    const first = await firstEvent(host, 'ask');
    // Give the second tool's ask time to arrive: it must queue, not replace.
    await new Promise((r) => setTimeout(r, 50));
    expect(events().filter((e) => e.type === 'ask')).toHaveLength(1);
    expect((await host.snapshot()).pendingAsk?.askId).toBe(first.askId);

    const secondP = firstEvent(host, 'ask');
    host.answerAsk(first.askId, 'once');
    const second = await secondP;
    expect(second.askId).not.toBe(first.askId);
    expect((second.input as { path: string }).path).not.toBe((first.input as { path: string }).path);
    host.answerAsk(second.askId, 'once');

    const end = await settled;
    expect(end).toMatchObject({ type: 'run_end', stopReason: 'end_turn' });
    const ends = events().filter((e) => e.type === 'tool_call_end') as Array<{ result: { isError?: boolean } }>;
    expect(ends).toHaveLength(2);
    expect(ends.every((e) => !e.result.isError)).toBe(true);
  });

  it('abort settles the shown ask and every queued one', async () => {
    const { host, events } = await makeHost(
      [
        {
          toolCalls: [
            { name: 'write', input: { path: 'a.txt', content: 'a' } },
            { name: 'write', input: { path: 'b.txt', content: 'b' } },
          ],
        },
        { text: 'unused' },
      ],
      { mode: 'ask' },
    );
    const settled = runSettled(host);
    host.send('go');
    await firstEvent(host, 'ask');
    await new Promise((r) => setTimeout(r, 50));
    host.abort();
    await settled; // would hang forever if a queued ask were left dangling
    expect(host.pending).toBe(false);
    expect(events().filter((e) => e.type === 'ask')).toHaveLength(1);
  });

  it('broadcasts a mode event when plan approval switches the mode, once per change', async () => {
    const { host, events } = await makeHost(
      [
        { toolCalls: [{ name: 'exit_plan_mode', input: { title: 'P', plan: '1. do it' } }] },
        { text: 'approved, proceeding' },
      ],
      { mode: 'plan' },
    );
    const planP = firstEvent(host, 'plan');
    const settled = runSettled(host);
    host.send('go');
    const { planId } = await planP;
    host.answerPlan(planId, true);
    await settled;

    const modes = events().filter((e) => e.type === 'mode') as Array<{ mode: string }>;
    const { mode } = await host.snapshot();
    expect(mode).not.toBe('plan');
    expect(modes).toEqual([{ type: 'mode', mode }]);

    // An explicit setMode emits exactly one event; re-setting the same mode emits none.
    host.setMode('readOnly');
    host.setMode('readOnly');
    expect(events().filter((e) => e.type === 'mode')).toHaveLength(2);
  });

  it('replays the gap after sinceSeq while the ring still covers it', async () => {
    const { host, frames } = await makeHost([{ text: 'hello world', chunkSize: 3 }]);
    const settled = runSettled(host);
    host.send('go');
    await settled;

    expect(host.canReplay(2)).toBe(true);
    const gap = host.since(2);
    const gapSeqs = gap.map((f) => (f as { seq: number }).seq);
    expect(Math.min(...gapSeqs)).toBe(3);
    expect(gapSeqs).toEqual([...gapSeqs].sort((a, b) => a - b));
    // The gap is exactly the frames after seq 2.
    const allSeqs = frames.filter((f) => f.t === 'evt').map((f) => (f as { seq: number }).seq);
    expect(gapSeqs).toEqual(allSeqs.filter((s) => s > 2));
  });

  it('cannot replay when the client is ahead of a reset host', async () => {
    const { host } = await makeHost([{ text: 'hi' }]);
    const settled = runSettled(host);
    host.send('go');
    await settled;

    // A client that saw more events than this host has produced (e.g. the
    // session was resumed from disk) must be told to reset.
    expect(host.canReplay(host.lastSeq + 100)).toBe(false);
    const snapshot = await host.snapshot();
    expect(snapshot.lastSeq).toBe(host.lastSeq);
  });
});
