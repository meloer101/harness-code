import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DEFAULT_CAPABILITIES } from '../provider/capabilities.js';
import { ScriptedProvider } from '../provider/mock.js';
import type { ResolvedModel } from '../provider/router.js';
import { userText } from '../provider/types.js';
import type { ToolSpec } from '../tools/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { AgentLoop } from './loop.js';
import { allowAllHooks } from './hooks.js';
import type { AgentHooks } from './hooks.js';

function resolvedModel(
  provider: ScriptedProvider,
  capsOverride: Partial<typeof DEFAULT_CAPABILITIES> = {},
): ResolvedModel {
  return {
    provider,
    providerId: provider.id,
    model: 'scripted-model',
    ref: `${provider.id}/scripted-model`,
    capabilities: { ...DEFAULT_CAPABILITIES, ...capsOverride },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const noInput = z.object({});

function trackingTool(opts: {
  name: string;
  readOnly: boolean;
  concurrencySafe: boolean;
  onRun?: () => void;
  activeCounter?: { active: number; max: number };
}): ToolSpec<unknown> {
  return {
    name: opts.name,
    description: 'test tool',
    schema: noInput,
    readOnly: opts.readOnly,
    concurrencySafe: opts.concurrencySafe,
    async execute() {
      opts.onRun?.();
      if (opts.activeCounter) {
        opts.activeCounter.active++;
        opts.activeCounter.max = Math.max(opts.activeCounter.max, opts.activeCounter.active);
      }
      await delay(30);
      if (opts.activeCounter) opts.activeCounter.active--;
      return { content: `${opts.name} ran` };
    },
  };
}

describe('AgentLoop', () => {
  it('runs a tool call and finishes on the following text-only turn', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'echo', input: {} }] },
      { text: 'done' },
    ]);
    const tools = new ToolRegistry([
      trackingTool({ name: 'echo', readOnly: true, concurrencySafe: true }),
    ]);
    const loop = new AgentLoop({ model: resolvedModel(provider), tools, cwd: '/tmp' });

    const result = await loop.run([userText('hi')]);

    expect(result.stopReason).toBe('end_turn');
    expect(provider.callCount).toBe(2);
    // user, assistant(tool_use), user(tool_result), assistant(final text)
    expect(result.messages).toHaveLength(4);
    expect(result.messages[2]?.content[0]).toMatchObject({
      type: 'tool_result',
      content: 'echo ran',
    });
  });

  it('runs concurrency-safe read-only tools in parallel', async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { name: 'readA', input: {} },
          { name: 'readB', input: {} },
        ],
      },
      { text: 'done' },
    ]);
    const counter = { active: 0, max: 0 };
    const tools = new ToolRegistry([
      trackingTool({ name: 'readA', readOnly: true, concurrencySafe: true, activeCounter: counter }),
      trackingTool({ name: 'readB', readOnly: true, concurrencySafe: true, activeCounter: counter }),
    ]);
    const loop = new AgentLoop({ model: resolvedModel(provider), tools, cwd: '/tmp' });

    await loop.run([userText('hi')]);

    expect(counter.max).toBe(2);
  });

  it('runs write-like tools serially, never overlapping', async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { name: 'writeA', input: {} },
          { name: 'writeB', input: {} },
        ],
      },
      { text: 'done' },
    ]);
    const counter = { active: 0, max: 0 };
    const tools = new ToolRegistry([
      trackingTool({ name: 'writeA', readOnly: false, concurrencySafe: false, activeCounter: counter }),
      trackingTool({ name: 'writeB', readOnly: false, concurrencySafe: false, activeCounter: counter }),
    ]);
    const loop = new AgentLoop({ model: resolvedModel(provider), tools, cwd: '/tmp' });

    await loop.run([userText('hi')]);

    expect(counter.max).toBe(1);
  });

  it('denies a tool call via hooks without executing it', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'danger', input: {} }] },
      { text: 'done' },
    ]);
    let ran = false;
    const tools = new ToolRegistry([
      trackingTool({ name: 'danger', readOnly: false, concurrencySafe: false, onRun: () => { ran = true; } }),
    ]);
    const hooks: AgentHooks = {
      onBeforeToolCall: () => ({ decision: 'deny', reason: 'not allowed in this test' }),
    };
    const loop = new AgentLoop({ model: resolvedModel(provider), tools, cwd: '/tmp', hooks });

    const result = await loop.run([userText('hi')]);

    expect(ran).toBe(false);
    const toolResult = result.messages[2]?.content[0];
    expect(toolResult).toMatchObject({ type: 'tool_result', isError: true });
  });

  it('does not execute a tool when the ask handler denies', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createPermissionEngine, createPermissionHooks, nonInteractiveAskHandler } =
      await import('../permissions/index.js');

    const cwd = await mkdtemp(join(tmpdir(), 'hc-loop-perm-'));
    try {
      let ran = false;
      const provider = new ScriptedProvider([
        { toolCalls: [{ name: 'bash', input: { command: 'echo hi' } }] },
        { text: 'done' },
      ]);
      const tools = new ToolRegistry([
        trackingTool({
          name: 'bash',
          readOnly: false,
          concurrencySafe: false,
          onRun: () => {
            ran = true;
          },
        }),
      ]);
      const engine = createPermissionEngine({
        workspaceRoot: cwd,
        mode: 'ask',
        allow: [],
        ask: [],
        deny: [],
      });
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools,
        cwd,
        hooks: createPermissionHooks(engine, nonInteractiveAskHandler),
      });

      const result = await loop.run([userText('hi')]);

      expect(ran).toBe(false);
      expect(result.messages[2]?.content[0]).toMatchObject({ type: 'tool_result', isError: true });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('stops with max_turns once the budget is exhausted', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'echo', input: {} }] },
      { toolCalls: [{ name: 'echo', input: {} }] },
    ]);
    const tools = new ToolRegistry([
      trackingTool({ name: 'echo', readOnly: true, concurrencySafe: true }),
    ]);
    const loop = new AgentLoop({
      model: resolvedModel(provider),
      tools,
      cwd: '/tmp',
      maxTurns: 2,
    });

    const result = await loop.run([userText('hi')]);

    expect(result.stopReason).toBe('max_turns');
    expect(provider.callCount).toBe(2);
  });

  it('stops immediately with aborted when the signal is already tripped', async () => {
    const provider = new ScriptedProvider([{ text: 'never' }]);
    const tools = new ToolRegistry([]);
    const controller = new AbortController();
    controller.abort();
    const loop = new AgentLoop({
      model: resolvedModel(provider),
      tools,
      cwd: '/tmp',
      signal: controller.signal,
    });

    const result = await loop.run([userText('hi')]);

    expect(result.stopReason).toBe('aborted');
    expect(provider.callCount).toBe(0);
  });

  it('stops with max_tokens once cumulative usage passes the budget', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'echo', input: {} }], usage: { inputTokens: 100, outputTokens: 100 } },
      { text: 'unreached' },
    ]);
    const tools = new ToolRegistry([
      trackingTool({ name: 'echo', readOnly: true, concurrencySafe: true }),
    ]);
    const loop = new AgentLoop({
      model: resolvedModel(provider),
      tools,
      cwd: '/tmp',
      maxTokens: 150,
    });

    const result = await loop.run([userText('hi')]);

    expect(result.stopReason).toBe('max_tokens');
    expect(provider.callCount).toBe(1);
  });

  it('stops with context_limit when the history overflows the usable window', async () => {
    const provider = new ScriptedProvider([{ text: 'unreached' }]);
    const tools = new ToolRegistry([]);
    const loop = new AgentLoop({
      // usable window = 100 - 10 = 90 tokens; the prompt below dwarfs it
      model: resolvedModel(provider, { contextWindow: 100, maxOutputTokens: 10 }),
      tools,
      cwd: '/tmp',
    });

    const result = await loop.run([userText('x'.repeat(8000))]);

    expect(result.stopReason).toBe('context_limit');
    expect(provider.callCount).toBe(0);
  });

  it('calls onContextPressure with the ratio once the warn threshold is crossed', async () => {
    const provider = new ScriptedProvider([{ text: 'done' }]);
    const tools = new ToolRegistry([]);
    const seen: Array<{ ratio: number; usedTokens: number; windowTokens: number }> = [];
    const events: number[] = [];
    const loop = new AgentLoop({
      model: resolvedModel(provider, { contextWindow: 1000, maxOutputTokens: 100 }),
      tools,
      cwd: '/tmp',
      contextWarnRatio: 0,
      contextStopRatio: 5,
      hooks: {
        onBeforeToolCall: () => ({ decision: 'allow' }),
        onContextPressure: (_ctx, pressure) => {
          seen.push(pressure);
        },
      },
      onEvent: (e) => {
        if (e.type === 'context') events.push(e.ratio);
      },
    });

    await loop.run([userText('hello world')]);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.windowTokens).toBe(900);
    expect(seen[0]?.ratio).toBeGreaterThan(0);
    expect(events[0]).toBeCloseTo(seen[0]!.ratio);
  });

  it('passes maxOutputTokens and temperature through to the ModelRequest', async () => {
    const provider = new ScriptedProvider([{ text: 'done' }]);
    const tools = new ToolRegistry([]);
    const loop = new AgentLoop({
      model: resolvedModel(provider),
      tools,
      cwd: '/tmp',
      maxOutputTokens: 1234,
      temperature: 0.4,
    });

    await loop.run([userText('hi')]);

    expect(provider.requests[0]?.maxOutputTokens).toBe(1234);
    expect(provider.requests[0]?.temperature).toBe(0.4);
  });

  it('defaults maxOutputTokens to the model ceiling when unset', async () => {
    const provider = new ScriptedProvider([{ text: 'done' }]);
    const loop = new AgentLoop({
      model: resolvedModel(provider, { maxOutputTokens: 4096 }),
      tools: new ToolRegistry([]),
      cwd: '/tmp',
    });

    await loop.run([userText('hi')]);

    expect(provider.requests[0]?.maxOutputTokens).toBe(4096);
  });

  it('stops with stopped_by_tool when a tool result sets endsRun', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'finish', input: {} }] },
      { text: 'unreached' },
    ]);
    const finish: ToolSpec<unknown> = {
      name: 'finish',
      description: 'ends the run',
      schema: noInput,
      readOnly: false,
      concurrencySafe: false,
      async execute() {
        return { content: 'plan written', endsRun: true };
      },
    };
    const loop = new AgentLoop({
      model: resolvedModel(provider),
      tools: new ToolRegistry([finish]),
      cwd: '/tmp',
    });

    const result = await loop.run([userText('hi')]);

    expect(result.stopReason).toBe('stopped_by_tool');
    expect(provider.callCount).toBe(1);
    // the tool_result is still in history before the stop
    expect(result.messages.at(-1)?.content[0]).toMatchObject({
      type: 'tool_result',
      content: 'plan written',
    });
  });

  it('threads control through to a tool ctx', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'peek', input: {} }] },
      { text: 'done' },
    ]);
    let sawMode: string | undefined;
    const peek: ToolSpec<unknown> = {
      name: 'peek',
      description: 'reads control',
      schema: noInput,
      readOnly: true,
      concurrencySafe: true,
      async execute(_input, toolCtx) {
        sawMode = toolCtx.control?.mode;
        return { content: 'ok' };
      },
    };
    const loop = new AgentLoop({
      model: resolvedModel(provider),
      tools: new ToolRegistry([peek]),
      cwd: '/tmp',
      control: { mode: 'plan', exitPlanMode: () => 'acceptEdits' },
    });

    await loop.run([userText('hi')]);

    expect(sawMode).toBe('plan');
  });

  it('uses allowAllHooks by default', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'echo', input: {} }] },
      { text: 'done' },
    ]);
    const tools = new ToolRegistry([
      trackingTool({ name: 'echo', readOnly: true, concurrencySafe: true }),
    ]);
    const loop = new AgentLoop({ model: resolvedModel(provider), tools, cwd: '/tmp', hooks: allowAllHooks });

    const result = await loop.run([userText('hi')]);

    expect(result.stopReason).toBe('end_turn');
  });
});
