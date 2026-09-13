import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CAPABILITIES, ScriptedProvider, SessionRecorder } from '@harness-code/core';
import type { ResolvedModel, ScriptedTurn } from '@harness-code/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionPreviewNotFoundError, SessionRegistry } from './registry.js';

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function scriptedModel(turns: readonly ScriptedTurn[] = []): ResolvedModel {
  const provider = new ScriptedProvider(turns);
  return {
    provider,
    providerId: provider.id,
    model: 'test-model',
    ref: `${provider.id}/test-model`,
    capabilities: { ...DEFAULT_CAPABILITIES },
  };
}

function registry(cwd: string, agentDir: string, buildConfig = vi.fn()) {
  return new SessionRegistry({
    cwd,
    agentDir,
    buildConfig,
    previewDefaults: async () => ({ modelRef: 'scripted/test-model', mode: 'ask' }),
  });
}

describe('SessionRegistry.preview', () => {
  it('returns disk transcript without calling buildConfig', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'hc-registry-'));
    tmpDirs.push(cwd);
    const agentDir = join(cwd, '.agent');
    const buildConfig = vi.fn(() =>
      Promise.resolve({
        cwd,
        model: scriptedModel(),
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
    );
    const reg = registry(cwd, agentDir, buildConfig);

    const recorder = new SessionRecorder(agentDir, 'disk-only');
    await recorder.recordMessage({ role: 'user', content: [{ type: 'text', text: 'hello' }] });

    const snap = await reg.preview({ id: 'disk-only' });
    expect(snap.transcript).toHaveLength(1);
    expect(snap.transcript[0]).toMatchObject({ type: 'message' });
    expect(snap.running).toBe(false);
    expect(snap.lastSeq).toBe(0);
    expect(buildConfig).not.toHaveBeenCalled();
  });

  it('throws when the session file is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'hc-registry-'));
    tmpDirs.push(cwd);
    const reg = registry(cwd, join(cwd, '.agent'), vi.fn());
    await expect(reg.preview({ id: 'missing' })).rejects.toBeInstanceOf(SessionPreviewNotFoundError);
  });
});
