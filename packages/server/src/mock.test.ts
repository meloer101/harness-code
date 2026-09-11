/**
 * `--mock` mode: the scripted factory must drive a real `AgentSession` through
 * the full demo reel — streamed thinking + text, a `bash` tool, `write`/`edit`
 * file tools that each prompt for permission, and a plan approval — so the
 * frontend has something realistic to render without spending on the API.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerFrame, WireEvent } from '@harness-code/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { SessionHost } from './host.js';
import { mockConfigFactory } from './mock.js';
import { SessionRegistry } from './registry.js';

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runSettled(host: SessionHost): Promise<void> {
  return new Promise((resolve) => {
    const unsub = host.addListener((f) => {
      if (f.t === 'evt' && (f.event.type === 'run_end' || f.event.type === 'run_error')) {
        unsub();
        resolve();
      }
    });
  });
}

describe('mock mode', () => {
  it('plays the fixed script: text, thinking, bash/edit tools, an ask, and a plan', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'hc-mock-'));
    tmpDirs.push(cwd);
    const registry = new SessionRegistry({
      cwd,
      agentDir: join(cwd, '.agent'),
      buildConfig: mockConfigFactory(cwd),
    });
    const snapshot = await registry.create({});
    const host = registry.get(snapshot.id);
    if (!host) throw new Error('mock host not registered');
    expect(snapshot.mode).toBe('ask');

    const frames: ServerFrame[] = [];
    host.addListener((f) => frames.push(f));
    // Auto-approve every prompt as it arrives, mimicking a user clicking through.
    host.addListener((f) => {
      if (f.t !== 'evt') return;
      if (f.event.type === 'ask') host.answerAsk(f.event.askId, 'once');
      else if (f.event.type === 'plan') host.answerPlan(f.event.planId, true);
    });

    // Send #1 drives thinking/text and the bash/write/edit tools.
    let settled = runSettled(host);
    host.send('take a look around');
    await settled;

    // Send #2, in plan mode, drives the plan approval.
    host.setMode('plan');
    settled = runSettled(host);
    host.send('now make a plan');
    await settled;

    const events: WireEvent[] = frames.flatMap((f) => (f.t === 'evt' ? [f.event] : []));
    const types = new Set(events.map((e) => e.type));
    const toolNames = new Set(
      events.flatMap((e) => (e.type === 'tool_call_start' ? [e.name] : [])),
    );

    expect(types.has('thinking_delta')).toBe(true);
    expect(types.has('text_delta')).toBe(true);
    expect(types.has('ask')).toBe(true);
    expect(types.has('plan')).toBe(true);
    expect(types.has('resolved')).toBe(true);
    expect(toolNames.has('bash')).toBe(true);
    expect(toolNames.has('write')).toBe(true);
    expect(toolNames.has('edit')).toBe(true);

    // The plan was actually approved (resolved by the user, not an abort).
    const planResolved = events.some((e) => e.type === 'resolved' && e.by === 'user');
    expect(planResolved).toBe(true);
  });
});
