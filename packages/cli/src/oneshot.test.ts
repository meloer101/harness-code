import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CAPABILITIES, ScriptedProvider } from '@harness-code/core';
import type { AgentSessionConfig, ScriptedTurn } from '@harness-code/core';
import { runOneshot } from './oneshot.js';
import { JsonSink } from './output.js';
import type { ResultJSON } from './output.js';

const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

const tmpDirs: string[] = [];
afterEach(async () => {
  stdoutWrite.mockClear();
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function config(turns: ScriptedTurn[]): Promise<AgentSessionConfig> {
  const cwd = await mkdtemp(join(tmpdir(), 'hc-oneshot-'));
  tmpDirs.push(cwd);
  const provider = new ScriptedProvider(turns);
  return {
    cwd,
    model: {
      provider,
      providerId: provider.id,
      model: 'test-model',
      ref: `${provider.id}/test-model`,
      capabilities: { ...DEFAULT_CAPABILITIES },
    },
    settings: {},
    budgets: {},
    skills: false,
    subagents: false,
    mcp: false,
    memory: false,
    recorder: false,
    trace: false,
    projectMemory: null,
    mode: 'yolo',
  };
}

function stdoutResult(): ResultJSON {
  const out = stdoutWrite.mock.calls.map((c) => String(c[0])).join('');
  expect(out.trimEnd().split('\n')).toHaveLength(1);
  return JSON.parse(out) as ResultJSON;
}

describe('runOneshot', () => {
  it('writes an error result to stdout, then rethrows, when the run dies', async () => {
    const cfg = await config([
      { toolCalls: [{ name: 'glob', input: { pattern: '*' } }], usage: { inputTokens: 50, outputTokens: 5 } },
      { error: { kind: 'auth', message: 'bad key' } },
    ]);

    await expect(
      runOneshot({ config: cfg, prompt: 'go', sink: new JsonSink(), interactive: false }),
    ).rejects.toMatchObject({ name: 'ProviderError', kind: 'auth' });

    expect(stdoutResult()).toMatchObject({
      type: 'result',
      stop_reason: 'error',
      turns: 1,
      is_error: true,
      usage: { input_tokens: 50, output_tokens: 5 },
      error: { message: 'bad key', kind: 'auth' },
    });
  });

  it('still writes a normal result on success', async () => {
    const cfg = await config([{ text: 'all done' }]);

    await runOneshot({ config: cfg, prompt: 'go', sink: new JsonSink(), interactive: false });

    const result = stdoutResult();
    expect(result).toMatchObject({ stop_reason: 'end_turn', result: 'all done', is_error: false });
    expect(result.error).toBeUndefined();
  });
});
