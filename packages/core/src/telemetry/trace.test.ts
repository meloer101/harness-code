import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AgentLoop } from '../agent/loop.js';
import { DEFAULT_CAPABILITIES } from '../provider/capabilities.js';
import { ScriptedProvider } from '../provider/mock.js';
import type { ResolvedModel } from '../provider/router.js';
import { ProviderError, userText } from '../provider/types.js';
import type { Provider, StreamEvent } from '../provider/types.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolSpec } from '../tools/types.js';
import { TraceRecorder, listTraceIds, readTrace, tracePath } from './trace.js';
import type { TraceEvent } from './trace.js';

function model(provider: Provider, caps: Partial<typeof DEFAULT_CAPABILITIES> = {}): ResolvedModel {
  return {
    provider,
    providerId: provider.id,
    model: 'scripted-model',
    ref: `${provider.id}/scripted-model`,
    capabilities: { ...DEFAULT_CAPABILITIES, ...caps },
  };
}

const echoTool = (impl: () => Promise<{ content: string; isError?: boolean }>): ToolSpec<unknown> => ({
  name: 'echo',
  description: 'test tool',
  schema: z.object({}).passthrough(),
  readOnly: true,
  concurrencySafe: true,
  execute: impl,
});

describe('tracePath', () => {
  it('is <agentDir>/traces/<id>.jsonl', () => {
    expect(tracePath('/w/.agent', 'abc')).toBe('/w/.agent/traces/abc.jsonl');
  });
});

describe('TraceRecorder / readTrace', () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await realpath(await mkdtemp(join(tmpdir(), 'hc-trace-')));
  });
  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  it('round-trips events in append order', async () => {
    const rec = new TraceRecorder(agentDir, 's1');
    await rec.append({ type: 'run_start', ts: 1, sessionId: 's1', model: 'p/m', cwd: '/w' });
    await rec.append({
      type: 'run_end',
      ts: 2,
      stopReason: 'end_turn',
      turns: 1,
      inputTokens: 10,
      outputTokens: 3,
      cachedInputTokens: 0,
      wallMs: 5,
    });

    const events = await readTrace(agentDir, 's1');
    expect(events.map((e) => e.type)).toEqual(['run_start', 'run_end']);
  });

  it('skips a torn final line instead of throwing', async () => {
    const rec = new TraceRecorder(agentDir, 's2');
    await rec.append({ type: 'run_start', ts: 1, sessionId: 's2', model: 'p/m', cwd: '/w' });
    await writeFile(tracePath(agentDir, 's2'), '{"type":"model_call","ts":2,', { flag: 'a' });

    const events = await readTrace(agentDir, 's2');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('run_start');
  });

  it('caps a large tool-call input summary', async () => {
    const rec = new TraceRecorder(agentDir, 's3');
    await rec.toolCall({
      turn: 1,
      id: 'c1',
      name: 'write',
      input: { path: 'a', body: 'x'.repeat(5000) },
      durationMs: 12,
      result: { content: 'ok' },
    });
    const [ev] = await readTrace(agentDir, 's3');
    expect(ev?.type).toBe('tool_call');
    if (ev?.type === 'tool_call') {
      expect(ev.inputSummary.length).toBeLessThan(220);
      expect(ev.inputSummary.endsWith('…')).toBe(true);
      expect(ev.outputBytes).toBe(2);
    }
  });

  it('lists trace ids newest first', async () => {
    await new TraceRecorder(agentDir, 'old').append({
      type: 'run_start',
      ts: 1,
      sessionId: 'old',
      model: 'p/m',
      cwd: '/w',
    });
    await new Promise((r) => setTimeout(r, 10));
    await new TraceRecorder(agentDir, 'new').append({
      type: 'run_start',
      ts: 2,
      sessionId: 'new',
      model: 'p/m',
      cwd: '/w',
    });

    const ids = (await listTraceIds(agentDir)).map((t) => t.id);
    expect(ids).toEqual(['new', 'old']);
  });

  it('returns [] when there is no traces directory', async () => {
    expect(await listTraceIds(join(agentDir, 'nope'))).toEqual([]);
  });
});

describe('TraceRecorder driven by AgentLoop', () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await realpath(await mkdtemp(join(tmpdir(), 'hc-trace-')));
  });
  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  it('records a model_call (with cost) and a tool_call (with duration)', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'echo', input: { q: 1 } }], usage: { inputTokens: 100, outputTokens: 20 } },
      { text: 'done', usage: { inputTokens: 120, outputTokens: 8 } },
    ]);
    const trace = new TraceRecorder(agentDir, 'run');
    const loop = new AgentLoop({
      model: model(provider, { pricing: { inputPerMTok: 1, outputPerMTok: 2 } }),
      tools: new ToolRegistry([echoTool(async () => ({ content: 'echoed' }))]),
      cwd: '/tmp',
      trace,
    });

    const result = await loop.run([userText('hi')]);
    expect(result.turns).toBe(2);

    const events = await readTrace(agentDir, 'run');
    const modelCalls = events.filter((e): e is Extract<TraceEvent, { type: 'model_call' }> => e.type === 'model_call');
    const toolCalls = events.filter((e): e is Extract<TraceEvent, { type: 'tool_call' }> => e.type === 'tool_call');

    expect(modelCalls).toHaveLength(2);
    expect(modelCalls[0]?.inputTokens).toBe(100);
    expect(modelCalls[0]?.model).toBe('scripted/scripted-model');
    // 100 fresh in @ $1/M + 20 out @ $2/M = 0.00014
    expect(modelCalls[0]?.costUSD).toBeCloseTo(0.00014, 8);
    expect(modelCalls[0]?.estimated).toBe(true);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.name).toBe('echo');
    expect(toolCalls[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(toolCalls[0]?.isError).toBe(false);
    expect(toolCalls[0]?.outputBytes).toBe('echoed'.length);
  });

  it('records a tool_call flagged isError without an error event', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'echo', input: {} }] },
      { text: 'ok' },
    ]);
    const trace = new TraceRecorder(agentDir, 'run');
    const loop = new AgentLoop({
      model: model(provider),
      tools: new ToolRegistry([echoTool(async () => ({ content: 'boom', isError: true }))]),
      cwd: '/tmp',
      trace,
    });
    await loop.run([userText('hi')]);

    const events = await readTrace(agentDir, 'run');
    const tool = events.find((e): e is Extract<TraceEvent, { type: 'tool_call' }> => e.type === 'tool_call');
    expect(tool?.isError).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('flags a permission-denied tool call as denied', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'echo', input: {} }] },
      { text: 'ok' },
    ]);
    const trace = new TraceRecorder(agentDir, 'run');
    const loop = new AgentLoop({
      model: model(provider),
      tools: new ToolRegistry([echoTool(async () => ({ content: 'should not run' }))]),
      cwd: '/tmp',
      hooks: { onBeforeToolCall: () => ({ decision: 'deny', reason: 'blocked by test' }) },
      trace,
    });
    await loop.run([userText('hi')]);

    const events = await readTrace(agentDir, 'run');
    const tool = events.find((e): e is Extract<TraceEvent, { type: 'tool_call' }> => e.type === 'tool_call');
    expect(tool?.denied).toBe(true);
    expect(tool?.isError).toBe(true);
  });

  it('records an error event when the provider throws', async () => {
    const throwing: Provider = {
      id: 'boom',
      async complete() {
        throw new ProviderError('server', 'upstream 500');
      },
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<StreamEvent> {
        throw new ProviderError('server', 'upstream 500');
      },
    };
    const trace = new TraceRecorder(agentDir, 'run');
    const loop = new AgentLoop({
      model: model(throwing),
      tools: new ToolRegistry([]),
      cwd: '/tmp',
      trace,
    });

    await expect(loop.run([userText('hi')])).rejects.toThrow('upstream 500');
    const events = await readTrace(agentDir, 'run');
    const err = events.find((e): e is Extract<TraceEvent, { type: 'error' }> => e.type === 'error');
    expect(err?.scope).toBe('provider');
    expect(err?.message).toContain('upstream 500');
  });
});
