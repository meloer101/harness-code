import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DEFAULT_CAPABILITIES } from '../provider/capabilities.js';
import { ScriptedProvider } from '../provider/mock.js';
import type { ResolvedModel } from '../provider/router.js';
import { userText } from '../provider/types.js';
import type { Message } from '../provider/types.js';
import type { ToolSpec } from '../tools/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { AgentLoop } from './loop.js';
import type { AgentEvent } from './loop.js';
import { allowAllHooks } from './hooks.js';
import type { AgentHooks } from './hooks.js';
import { SessionState } from './session.js';

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
  delayMs?: number;
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
      await delay(opts.delayMs ?? 30);
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

  it('sends reasoning_effort only for reasoning-capable models', async () => {
    const tools = new ToolRegistry([]);

    const reasoning = new ScriptedProvider([{ text: 'ok' }]);
    await new AgentLoop({
      model: resolvedModel(reasoning, { reasoning: true }),
      tools,
      cwd: '/tmp',
      reasoningEffort: 'high',
    }).run([userText('hi')]);
    expect(reasoning.requests[0]?.extraBody).toEqual({ reasoning_effort: 'high' });

    const plain = new ScriptedProvider([{ text: 'ok' }]);
    await new AgentLoop({
      model: resolvedModel(plain, { reasoning: false }),
      tools,
      cwd: '/tmp',
      reasoningEffort: 'high',
    }).run([userText('hi')]);
    expect(plain.requests[0]?.extraBody).toBeUndefined();
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

  it('runs concurrency-safe tools in parallel even when they are not read-only', async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { name: 'taskA', input: {} },
          { name: 'taskB', input: {} },
        ],
      },
      { text: 'done' },
    ]);
    const counter = { active: 0, max: 0 };
    const tools = new ToolRegistry([
      trackingTool({ name: 'taskA', readOnly: false, concurrencySafe: true, activeCounter: counter }),
      trackingTool({ name: 'taskB', readOnly: false, concurrencySafe: true, activeCounter: counter }),
    ]);
    const loop = new AgentLoop({ model: resolvedModel(provider), tools, cwd: '/tmp' });

    await loop.run([userText('hi')]);

    expect(counter.max).toBe(2);
  });

  it('emits tool_call_end in the model\'s emission order even when a later call finishes first', async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { name: 'slow', input: {} },
          { name: 'fast', input: {} },
        ],
      },
      { text: 'done' },
    ]);
    const tools = new ToolRegistry([
      trackingTool({ name: 'slow', readOnly: true, concurrencySafe: true, delayMs: 40 }),
      trackingTool({ name: 'fast', readOnly: true, concurrencySafe: true, delayMs: 5 }),
    ]);
    const events: AgentEvent[] = [];
    const loop = new AgentLoop({
      model: resolvedModel(provider),
      tools,
      cwd: '/tmp',
      onEvent: (e) => events.push(e),
    });

    await loop.run([userText('hi')]);

    const isStart = (e: AgentEvent): e is Extract<AgentEvent, { type: 'tool_call_start' }> =>
      e.type === 'tool_call_start';
    const isEnd = (e: AgentEvent): e is Extract<AgentEvent, { type: 'tool_call_end' }> =>
      e.type === 'tool_call_end';
    const startOrder = events.filter(isStart).map((e) => e.name);
    const endOrder = events.filter(isEnd).map((e) => e.name);
    expect(startOrder).toEqual(['slow', 'fast']);
    expect(endOrder).toEqual(['slow', 'fast']);
  });

  it('preserves model order: a write barrier runs before a following read', async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { name: 'edit', input: {} },
          { name: 'read', input: {} },
        ],
      },
      { text: 'done' },
    ]);
    const order: string[] = [];
    const tools = new ToolRegistry([
      trackingTool({
        name: 'edit',
        readOnly: false,
        concurrencySafe: false,
        onRun: () => {
          order.push('edit');
        },
      }),
      trackingTool({
        name: 'read',
        readOnly: true,
        concurrencySafe: true,
        onRun: () => {
          order.push('read');
        },
      }),
    ]);
    const loop = new AgentLoop({ model: resolvedModel(provider), tools, cwd: '/tmp' });

    await loop.run([userText('hi')]);

    expect(order).toEqual(['edit', 'read']);
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

  it('stops with max_tokens when the model truncates a text-only turn', async () => {
    const provider = new ScriptedProvider([
      { text: 'half-finished…', stopReason: 'max_tokens' },
    ]);
    const loop = new AgentLoop({
      model: resolvedModel(provider),
      tools: new ToolRegistry([]),
      cwd: '/tmp',
    });

    const result = await loop.run([userText('hi')]);

    expect(result.stopReason).toBe('max_tokens');
    expect(provider.callCount).toBe(1);
  });

  it('stops with content_filter when the provider filters the response', async () => {
    const provider = new ScriptedProvider([
      { text: '', stopReason: 'content_filter' },
    ]);
    const loop = new AgentLoop({
      model: resolvedModel(provider),
      tools: new ToolRegistry([]),
      cwd: '/tmp',
    });

    const result = await loop.run([userText('hi')]);

    expect(result.stopReason).toBe('content_filter');
  });

  it('returns an error tool_result and continues when truncation hits mid tool args', async () => {
    const provider = new ScriptedProvider([
      {
        stopReason: 'max_tokens',
        toolCalls: [
          {
            name: 'write',
            input: {},
            parseError: 'Unexpected end of JSON input',
          },
        ],
      },
      { text: 'retried as smaller writes' },
    ]);
    const tools = new ToolRegistry([
      trackingTool({ name: 'write', readOnly: false, concurrencySafe: false }),
    ]);
    const loop = new AgentLoop({
      model: resolvedModel(provider),
      tools,
      cwd: '/tmp',
    });

    const result = await loop.run([userText('hi')]);

    expect(result.stopReason).toBe('end_turn');
    expect(provider.callCount).toBe(2);
    const toolResult = result.messages[2]?.content[0];
    expect(toolResult).toMatchObject({ type: 'tool_result', isError: true });
    expect((toolResult as { content: string }).content).toMatch(/output-token limit/i);
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

  it('caps the output reservation so a huge maxOutputTokens does not shrink the window', async () => {
    const provider = new ScriptedProvider([{ text: 'done' }]);
    const seen: number[] = [];
    const loop = new AgentLoop({
      // 1M window, model allows a 384k reply — but the reservation is capped at
      // 64k, so the usable window is ~936k, not ~616k.
      model: resolvedModel(provider, { contextWindow: 1_000_000, maxOutputTokens: 384_000 }),
      tools: new ToolRegistry([]),
      cwd: '/tmp',
      onEvent: (e) => {
        if (e.type === 'context') seen.push(e.windowTokens);
      },
    });

    await loop.run([userText('hi')]);

    expect(seen[0]).toBe(1_000_000 - 64_000);
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

  it('invokes onCompact at the compact ratio and continues with the replacement history', async () => {
    const provider = new ScriptedProvider([{ text: 'done' }]);
    const events: string[] = [];
    let sawCompactionEvent: { tokensBefore: number; tokensAfter: number; keptTurns: number } | undefined;
    const loop = new AgentLoop({
      model: resolvedModel(provider, { contextWindow: 1000, maxOutputTokens: 100 }),
      tools: new ToolRegistry([]),
      cwd: '/tmp',
      contextWarnRatio: 5,
      contextCompactRatio: 0,
      contextStopRatio: 5,
      hooks: {
        onBeforeToolCall: () => ({ decision: 'allow' }),
        onCompact: () => ({
          messages: [userText('compacted history')],
          usage: { inputTokens: 5, outputTokens: 5, cachedInputTokens: 0 },
          keptTurns: 2,
        }),
      },
      onEvent: (e) => {
        events.push(e.type);
        if (e.type === 'compaction') sawCompactionEvent = e;
      },
    });

    const result = await loop.run([userText('a much longer original prompt that we pretend overflowed')]);

    expect(result.stopReason).toBe('end_turn');
    expect(events).toContain('compaction');
    expect(sawCompactionEvent?.keptTurns).toBe(2);
    expect(result.messages[0]).toEqual(userText('compacted history'));
    expect(result.usage.inputTokens).toBeGreaterThanOrEqual(5);
  });

  it('does not invoke onCompact below the compact ratio (only onContextPressure)', async () => {
    const provider = new ScriptedProvider([{ text: 'done' }]);
    let compactCalls = 0;
    let pressureCalls = 0;
    const loop = new AgentLoop({
      model: resolvedModel(provider, { contextWindow: 1000, maxOutputTokens: 100 }),
      tools: new ToolRegistry([]),
      cwd: '/tmp',
      contextWarnRatio: 0,
      contextCompactRatio: 5,
      contextStopRatio: 5,
      hooks: {
        onBeforeToolCall: () => ({ decision: 'allow' }),
        onContextPressure: () => {
          pressureCalls++;
        },
        onCompact: () => {
          compactCalls++;
          return undefined;
        },
      },
    });

    await loop.run([userText('hello world')]);

    expect(compactCalls).toBe(0);
    expect(pressureCalls).toBe(1);
  });

  it('still stops with context_limit when compaction is disabled', async () => {
    const provider = new ScriptedProvider([{ text: 'unreached' }]);
    let compactCalls = 0;
    const loop = new AgentLoop({
      model: resolvedModel(provider, { contextWindow: 100, maxOutputTokens: 10 }),
      tools: new ToolRegistry([]),
      cwd: '/tmp',
      contextCompactRatio: Number.POSITIVE_INFINITY,
      hooks: {
        onBeforeToolCall: () => ({ decision: 'allow' }),
        onCompact: () => {
          compactCalls++;
          return undefined;
        },
      },
    });

    const result = await loop.run([userText('x'.repeat(8000))]);

    expect(result.stopReason).toBe('context_limit');
    expect(compactCalls).toBe(0);
    expect(provider.callCount).toBe(0);
  });

  it('salvages a context_length provider error by compacting once and re-sending', async () => {
    const provider = new ScriptedProvider([
      { error: { kind: 'context_length', message: 'prompt too long', retryable: false } },
      { text: 'ok after compact' },
    ]);
    let compactCalls = 0;
    const events: string[] = [];
    const loop = new AgentLoop({
      model: resolvedModel(provider),
      tools: new ToolRegistry([]),
      cwd: '/tmp',
      // Keep ratio-based compact off so only the salvage path fires.
      contextCompactRatio: Number.POSITIVE_INFINITY,
      hooks: {
        onBeforeToolCall: () => ({ decision: 'allow' }),
        onCompact: () => {
          compactCalls++;
          return {
            messages: [userText('compacted')],
            keptTurns: 1,
          };
        },
      },
      onEvent: (e) => events.push(e.type),
    });

    const result = await loop.run([userText('huge history')]);

    expect(result.stopReason).toBe('end_turn');
    expect(compactCalls).toBe(1);
    expect(provider.callCount).toBe(2);
    expect(events).toContain('compaction');
    expect(result.messages[0]).toEqual(userText('compacted'));
  });

  it('rethrows context_length when onCompact is absent', async () => {
    const provider = new ScriptedProvider([
      { error: { kind: 'context_length', message: 'prompt too long', retryable: false } },
    ]);
    const loop = new AgentLoop({
      model: resolvedModel(provider),
      tools: new ToolRegistry([]),
      cwd: '/tmp',
      hooks: allowAllHooks,
    });

    await expect(loop.run([userText('hi')])).rejects.toMatchObject({
      kind: 'context_length',
    });
    expect(provider.callCount).toBe(1);
  });

  it('emits a context breakdown whose parts sum to the used total', async () => {
    const provider = new ScriptedProvider([{ text: 'done' }]);
    let ctx: { usedTokens: number; breakdown: { system: number; projectMemory: number; toolSchemas: number; history: number } } | undefined;
    const loop = new AgentLoop({
      model: resolvedModel(provider),
      tools: new ToolRegistry([
        trackingTool({ name: 'echo', readOnly: true, concurrencySafe: true }),
      ]),
      cwd: '/tmp',
      system: [
        { id: 'identity', text: 'you are an agent' },
        { id: 'project_memory', text: 'use 2-space indent' },
      ],
      onEvent: (e) => {
        if (e.type === 'context') ctx = e;
      },
    });

    await loop.run([userText('hello there')]);

    expect(ctx).toBeDefined();
    const b = ctx!.breakdown;
    expect(b.projectMemory).toBeGreaterThan(0);
    expect(b.system + b.projectMemory + b.toolSchemas + b.history).toBe(ctx!.usedTokens);
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

  describe('turn-budget hints', () => {
    function budgetNote(req: { messages: readonly Message[] } | undefined): string | undefined {
      const block = req?.messages
        .at(-1)
        ?.content.find(
          (b): b is { type: 'text'; text: string } =>
            b.type === 'text' && b.text.startsWith('[turn budget]'),
        );
      return block?.text;
    }
    function allBudgetNotes(req: { messages: readonly Message[] }): string[] {
      const notes: string[] = [];
      for (const m of req.messages) {
        for (const b of m.content) {
          if (b.type === 'text' && b.text.startsWith('[turn budget]')) notes.push(b.text);
        }
      }
      return notes;
    }
    const sixToolTurns = () =>
      new ScriptedProvider(
        Array.from({ length: 6 }, () => ({ toolCalls: [{ name: 'echo', input: {} }] })),
      );
    const echoTools = () =>
      new ToolRegistry([trackingTool({ name: 'echo', readOnly: true, concurrencySafe: true })]);

    it('stays silent before ~60% of the budget, then escalates', async () => {
      const provider = sixToolTurns();
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools: echoTools(),
        cwd: '/tmp',
        maxTurns: 6,
      });

      await loop.run([userText('hi')]);

      // turns 1-3: nothing (60% of 6 -> turn 4)
      expect(budgetNote(provider.requests[0])).toBeUndefined();
      expect(budgetNote(provider.requests[2])).toBeUndefined();
      // turn 4: converge
      expect(budgetNote(provider.requests[3])).toContain('past the two-thirds mark');
      // turn 5 (>= 80%): commit-and-verify
      expect(budgetNote(provider.requests[4])).toContain('Stop exploring');
      // turn 6: final
      expect(budgetNote(provider.requests[5])).toContain('final turn');
    });

    it('never persists the note — history stays clean and it does not accumulate', async () => {
      const provider = sixToolTurns();
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools: echoTools(),
        cwd: '/tmp',
        maxTurns: 6,
      });

      const result = await loop.run([userText('hi')]);

      // returned history carries no budget note
      expect(allBudgetNotes({ messages: result.messages })).toEqual([]);
      // each request carries at most the one note for that turn
      for (const req of provider.requests) {
        expect(allBudgetNotes(req).length).toBeLessThanOrEqual(1);
      }
    });

    it('is disabled by turnBudgetHints: false', async () => {
      const provider = sixToolTurns();
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools: echoTools(),
        cwd: '/tmp',
        maxTurns: 6,
        turnBudgetHints: false,
      });

      await loop.run([userText('hi')]);

      for (const req of provider.requests) expect(budgetNote(req)).toBeUndefined();
    });

    it('is disabled for a tiny turn budget', async () => {
      const provider = new ScriptedProvider([
        { toolCalls: [{ name: 'echo', input: {} }] },
        { toolCalls: [{ name: 'echo', input: {} }] },
        { toolCalls: [{ name: 'echo', input: {} }] },
      ]);
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools: echoTools(),
        cwd: '/tmp',
        maxTurns: 3,
      });

      await loop.run([userText('hi')]);

      for (const req of provider.requests) expect(budgetNote(req)).toBeUndefined();
    });
  });

  describe('step-back hints', () => {
    function stepBackNote(req: { messages: readonly Message[] } | undefined): string | undefined {
      return req?.messages
        .at(-1)
        ?.content.find(
          (b): b is { type: 'text'; text: string } =>
            b.type === 'text' && b.text.startsWith('[step back]'),
        )?.text;
    }
    const failTool: ToolSpec<unknown> = {
      name: 'boom',
      description: 'always errors',
      schema: noInput,
      readOnly: true,
      concurrencySafe: true,
      async execute() {
        return { content: 'nope', isError: true };
      },
    };
    // n failing tool turns, then a text turn so the loop ends cleanly.
    const nFailTurns = (n: number) =>
      new ScriptedProvider([
        ...Array.from({ length: n }, () => ({ toolCalls: [{ name: 'boom', input: {} }] })),
        { text: 'giving up' },
      ]);

    it('fires after 3 consecutive all-failed turns', async () => {
      const provider = nFailTurns(6);
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools: new ToolRegistry([failTool]),
        cwd: '/tmp',
        maxTurns: 30, // high, so the budget note stays out of the way
      });

      await loop.run([userText('hi')]);

      // turns 1-3 build up the count; the note first appears on turn 4's request
      expect(stepBackNote(provider.requests[0])).toBeUndefined();
      expect(stepBackNote(provider.requests[2])).toBeUndefined();
      expect(stepBackNote(provider.requests[3])).toContain("last 3 turns' tool calls");
      expect(stepBackNote(provider.requests[4])).toContain("last 4 turns' tool calls");
    });

    it('resets on a successful tool turn', async () => {
      // fail, fail, fail, succeed, fail, fail
      const provider = new ScriptedProvider([
        { toolCalls: [{ name: 'boom', input: {} }] },
        { toolCalls: [{ name: 'boom', input: {} }] },
        { toolCalls: [{ name: 'boom', input: {} }] },
        { toolCalls: [{ name: 'ok', input: {} }] },
        { toolCalls: [{ name: 'boom', input: {} }] },
        { toolCalls: [{ name: 'boom', input: {} }] },
        { text: 'done' },
      ]);
      const okTool: ToolSpec<unknown> = {
        name: 'ok',
        description: 'succeeds',
        schema: noInput,
        readOnly: true,
        concurrencySafe: true,
        async execute() {
          return { content: 'fine' };
        },
      };
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools: new ToolRegistry([failTool, okTool]),
        cwd: '/tmp',
        maxTurns: 30,
      });

      await loop.run([userText('hi')]);

      expect(stepBackNote(provider.requests[3])).toContain("last 3 turns'"); // before the success
      expect(stepBackNote(provider.requests[4])).toBeUndefined(); // reset by the success
      expect(stepBackNote(provider.requests[5])).toBeUndefined(); // only 1 failure since
    });

    it('is disabled by stepBackHints: false', async () => {
      const provider = nFailTurns(6);
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools: new ToolRegistry([failTool]),
        cwd: '/tmp',
        maxTurns: 30,
        stepBackHints: false,
      });

      await loop.run([userText('hi')]);

      for (const req of provider.requests) expect(stepBackNote(req)).toBeUndefined();
    });
  });

  describe('turn retry on retryable provider errors', () => {
    const dropped = { kind: 'network' as const, message: 'dropped mid-stream', afterText: 'half an ans' };

    it('re-sends a turn whose stream dropped, emits turn_retry, and keeps history clean', async () => {
      const provider = new ScriptedProvider([{ error: dropped }, { text: 'the full answer' }]);
      const events: AgentEvent[] = [];
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools: new ToolRegistry([]),
        cwd: '/tmp',
        retryBackoffMs: () => 0,
        onEvent: (e) => events.push(e),
      });

      const result = await loop.run([userText('hi')]);

      expect(result.stopReason).toBe('end_turn');
      expect(result.turns).toBe(1);
      expect(provider.callCount).toBe(2);
      expect(result.messages).toHaveLength(2);
      expect(result.messages[1]?.content).toEqual([{ type: 'text', text: 'the full answer' }]);
      // The retry is signalled after the partial delta and before the good one.
      const kinds = events.filter((e) => e.type === 'text_delta' || e.type === 'turn_retry');
      expect(kinds).toEqual([
        { type: 'text_delta', text: 'half an ans' },
        { type: 'turn_retry', attempt: 1, maxAttempts: 2, delayMs: 0, message: 'dropped mid-stream' },
        { type: 'text_delta', text: 'the full answer' },
      ]);
    });

    it('prefers ProviderError.retryAfterMs over the backoff function', async () => {
      const provider = new ScriptedProvider([
        {
          error: {
            kind: 'rate_limit',
            message: 'slow down',
            retryable: true,
            retryAfterMs: 1234,
          },
        },
        { text: 'ok' },
      ]);
      const events: AgentEvent[] = [];
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools: new ToolRegistry([]),
        cwd: '/tmp',
        retryBackoffMs: () => 99_999,
        onEvent: (e) => events.push(e),
      });

      await loop.run([userText('hi')]);

      const retry = events.find((e) => e.type === 'turn_retry');
      expect(retry).toMatchObject({ type: 'turn_retry', delayMs: 1234 });
    });

    it('records the retried failure in the trace with willRetry', async () => {
      const provider = new ScriptedProvider([{ error: dropped }, { text: 'ok' }]);
      const errors: unknown[] = [];
      const trace = {
        modelCall: async () => {},
        toolCall: async () => {},
        compaction: async () => {},
        context: async () => {},
        error: async (r: unknown) => void errors.push(r),
      };
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools: new ToolRegistry([]),
        cwd: '/tmp',
        trace,
        retryBackoffMs: () => 0,
      });

      await loop.run([userText('hi')]);

      expect(errors).toEqual([
        { turn: 1, scope: 'provider', message: 'dropped mid-stream', willRetry: true },
      ]);
    });

    it('propagates the ProviderError once retries are exhausted', async () => {
      const provider = new ScriptedProvider([{ error: dropped }, { error: dropped }, { error: dropped }]);
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools: new ToolRegistry([]),
        cwd: '/tmp',
        retryBackoffMs: () => 0,
      });

      await expect(loop.run([userText('hi')])).rejects.toMatchObject({
        name: 'ProviderError',
        kind: 'network',
      });
      expect(provider.callCount).toBe(3); // 1 + 2 retries
    });

    it('does not retry a non-retryable error', async () => {
      const provider = new ScriptedProvider([{ error: { kind: 'auth' } }, { text: 'unreached' }]);
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools: new ToolRegistry([]),
        cwd: '/tmp',
        retryBackoffMs: () => 0,
      });

      await expect(loop.run([userText('hi')])).rejects.toMatchObject({ kind: 'auth' });
      expect(provider.callCount).toBe(1);
    });

    it('fails fast with maxTurnRetries: 0', async () => {
      const provider = new ScriptedProvider([{ error: dropped }, { text: 'unreached' }]);
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools: new ToolRegistry([]),
        cwd: '/tmp',
        maxTurnRetries: 0,
      });

      await expect(loop.run([userText('hi')])).rejects.toMatchObject({ kind: 'network' });
      expect(provider.callCount).toBe(1);
    });

    it('stops with aborted when the signal trips during the backoff wait', async () => {
      const provider = new ScriptedProvider([{ error: dropped }, { text: 'unreached' }]);
      const controller = new AbortController();
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools: new ToolRegistry([]),
        cwd: '/tmp',
        signal: controller.signal,
        retryBackoffMs: () => 10_000,
        onEvent: (e) => {
          if (e.type === 'turn_retry') controller.abort();
        },
      });

      const result = await loop.run([userText('hi')]);

      expect(result.stopReason).toBe('aborted');
      expect(provider.callCount).toBe(1);
    });
  });

  it('continues once when onBeforeStop returns continue, then ends', async () => {
    const provider = new ScriptedProvider([
      { text: 'draft answer' },
      { text: 'verified answer' },
    ]);
    let stopCalls = 0;
    const loop = new AgentLoop({
      model: resolvedModel(provider),
      tools: new ToolRegistry([]),
      cwd: '/tmp',
      hooks: {
        onBeforeToolCall: () => ({ decision: 'allow' }),
        onBeforeStop: () => {
          stopCalls++;
          if (stopCalls === 1) return { continue: 'Please verify once, then finish.' };
          return undefined;
        },
      },
    });

    const result = await loop.run([userText('hi')]);

    expect(result.stopReason).toBe('end_turn');
    expect(provider.callCount).toBe(2);
    expect(stopCalls).toBe(2);
    expect(result.messages.some((m) =>
      m.role === 'user' &&
      m.content.some((b) => b.type === 'text' && b.text.includes('verify once')),
    )).toBe(true);
  });

  it('caps onBeforeStop continuations at maxStopGateContinuations', async () => {
    const provider = new ScriptedProvider([
      { text: 'a' },
      { text: 'b' },
      { text: 'c' },
      { text: 'should not reach' },
    ]);
    let stopCalls = 0;
    const loop = new AgentLoop({
      model: resolvedModel(provider),
      tools: new ToolRegistry([]),
      cwd: '/tmp',
      maxStopGateContinuations: 2,
      hooks: {
        onBeforeToolCall: () => ({ decision: 'allow' }),
        onBeforeStop: () => {
          stopCalls++;
          return { continue: 'keep going' };
        },
      },
    });

    const result = await loop.run([userText('hi')]);

    // Initial end_turn + 2 continuations = 3 model calls, then stop despite continue.
    expect(result.stopReason).toBe('end_turn');
    expect(provider.callCount).toBe(3);
    expect(stopCalls).toBe(2);
  });

  it('omits tools on the final turn when finalSummaryTurn is set', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'echo', input: {} }] },
      { text: 'here is my summary of what I did' },
    ]);
    const tools = new ToolRegistry([
      trackingTool({ name: 'echo', readOnly: true, concurrencySafe: true }),
    ]);
    const loop = new AgentLoop({
      model: resolvedModel(provider),
      tools,
      cwd: '/tmp',
      maxTurns: 2,
      finalSummaryTurn: true,
      turnBudgetHints: false,
      stepBackHints: false,
    });

    const result = await loop.run([userText('hi')]);

    expect(result.stopReason).toBe('end_turn');
    expect(provider.callCount).toBe(2);
    expect(provider.requests[0]?.tools).toBeDefined();
    expect(provider.requests[1]?.tools).toBeUndefined();
    const lastReq = provider.requests[1]!;
    const lastText = lastReq.messages
      .at(-1)
      ?.content.filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    expect(lastText).toMatch(/Tools are disabled/i);
  });

  describe('skill allowed-tools masking', () => {
    const control = {
      mode: 'yolo' as const,
      activeSkills: [{ name: 'writing-tests', allowedTools: ['Read', 'Grep'] }],
      exitPlanMode: () => 'acceptEdits' as const,
    };

    it('keeps the tools array byte-identical across turns when a skill constrains tools', async () => {
      const provider = new ScriptedProvider([
        { toolCalls: [{ name: 'read', input: {} }] },
        { text: 'done' },
      ]);
      const tools = new ToolRegistry([
        trackingTool({ name: 'read', readOnly: true, concurrencySafe: true }),
        trackingTool({ name: 'write', readOnly: false, concurrencySafe: false }),
        trackingTool({ name: 'grep', readOnly: true, concurrencySafe: true }),
        trackingTool({ name: 'skill', readOnly: true, concurrencySafe: true }),
        trackingTool({ name: 'todo', readOnly: true, concurrencySafe: true }),
        trackingTool({ name: 'memory', readOnly: true, concurrencySafe: true }),
      ]);
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools,
        cwd: '/tmp',
        control,
        turnBudgetHints: false,
        stepBackHints: false,
      });

      await loop.run([userText('hi')]);

      expect(provider.requests).toHaveLength(2);
      expect(JSON.stringify(provider.requests[0]?.tools)).toBe(
        JSON.stringify(provider.requests[1]?.tools),
      );
      expect(provider.requests[0]?.tools?.map((t) => t.name).sort()).toEqual([
        'grep',
        'memory',
        'read',
        'skill',
        'todo',
        'write',
      ]);
    });

    it('denies a constrained-out tool without executing it', async () => {
      let writeRan = false;
      const provider = new ScriptedProvider([
        { toolCalls: [{ name: 'write', input: {} }] },
        { text: 'done' },
      ]);
      const tools = new ToolRegistry([
        trackingTool({ name: 'read', readOnly: true, concurrencySafe: true }),
        trackingTool({
          name: 'write',
          readOnly: false,
          concurrencySafe: false,
          onRun: () => {
            writeRan = true;
          },
        }),
        trackingTool({ name: 'skill', readOnly: true, concurrencySafe: true }),
        trackingTool({ name: 'todo', readOnly: true, concurrencySafe: true }),
        trackingTool({ name: 'memory', readOnly: true, concurrencySafe: true }),
      ]);
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools,
        cwd: '/tmp',
        control,
        turnBudgetHints: false,
        stepBackHints: false,
      });

      const result = await loop.run([userText('hi')]);

      expect(writeRan).toBe(false);
      const block = result.messages
        .flatMap((m) => m.content)
        .find((b) => b.type === 'tool_result');
      expect(block).toMatchObject({ isError: true });
      expect((block as { content: string }).content).toMatch(/Denied:.*write/i);
    });

    it('sends allowed_tools tool_choice only when the capability is on', async () => {
      const provider = new ScriptedProvider([{ text: 'done' }]);
      const tools = new ToolRegistry([
        trackingTool({ name: 'read', readOnly: true, concurrencySafe: true }),
        trackingTool({ name: 'write', readOnly: false, concurrencySafe: false }),
        trackingTool({ name: 'skill', readOnly: true, concurrencySafe: true }),
        trackingTool({ name: 'todo', readOnly: true, concurrencySafe: true }),
        trackingTool({ name: 'memory', readOnly: true, concurrencySafe: true }),
      ]);
      const loop = new AgentLoop({
        model: resolvedModel(provider, { allowedToolsChoice: true }),
        tools,
        cwd: '/tmp',
        control,
        turnBudgetHints: false,
        stepBackHints: false,
      });

      await loop.run([userText('hi')]);

      expect(provider.requests[0]?.toolChoice).toEqual({
        type: 'allowed_tools',
        mode: 'auto',
        names: expect.arrayContaining(['read', 'skill', 'todo', 'memory']),
      });
      expect((provider.requests[0]?.toolChoice as { names: string[] }).names).not.toContain(
        'write',
      );
    });

    it('does not send tool_choice on the prompt-tools path, but still gates execution', async () => {
      let writeRan = false;
      const provider = new ScriptedProvider([
        { toolCalls: [{ name: 'write', input: {} }] },
        { text: 'done' },
      ]);
      const tools = new ToolRegistry([
        trackingTool({ name: 'read', readOnly: true, concurrencySafe: true }),
        trackingTool({
          name: 'write',
          readOnly: false,
          concurrencySafe: false,
          onRun: () => {
            writeRan = true;
          },
        }),
        trackingTool({ name: 'skill', readOnly: true, concurrencySafe: true }),
        trackingTool({ name: 'todo', readOnly: true, concurrencySafe: true }),
        trackingTool({ name: 'memory', readOnly: true, concurrencySafe: true }),
      ]);
      const loop = new AgentLoop({
        model: resolvedModel(provider, { nativeTools: false }),
        tools,
        cwd: '/tmp',
        control,
        turnBudgetHints: false,
        stepBackHints: false,
      });

      const result = await loop.run([userText('hi')]);

      expect(provider.requests[0]?.toolChoice).toBeUndefined();
      expect(writeRan).toBe(false);
      const block = result.messages
        .flatMap((m) => m.content)
        .find((b) => b.type === 'tool_result');
      expect(block).toMatchObject({ isError: true });
    });
  });

  describe('goal reminder', () => {
    function lastNote(req: { messages: readonly Message[] } | undefined): string {
      return (
        req?.messages
          .at(-1)
          ?.content.filter((b) => b.type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('\n\n') ?? ''
      );
    }
    const nEchoTurns = (n: number) =>
      new ScriptedProvider(Array.from({ length: n }, () => ({ toolCalls: [{ name: 'echo', input: {} }] })));
    const echoTools = () =>
      new ToolRegistry([trackingTool({ name: 'echo', readOnly: true, concurrencySafe: true })]);

    it('stays silent before turn 12 and fires on turn 16 with the original goal and open todos', async () => {
      const provider = nEchoTurns(16);
      const session = new SessionState();
      session.setTodos([
        { id: '1', content: 'fix the parser', status: 'in_progress' },
        { id: '2', content: 'already done', status: 'completed' },
      ]);
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools: echoTools(),
        cwd: '/tmp',
        session,
        maxTurns: 16,
        turnBudgetHints: false,
        stepBackHints: false,
      });

      await loop.run([userText('fix the parser bug')]);

      expect(lastNote(provider.requests[10])).not.toMatch(/\[goal reminder\]/);
      const note = lastNote(provider.requests[15]);
      expect(note).toMatch(/\[goal reminder\]/);
      expect(note).toContain('fix the parser bug');
      expect(note).toContain('fix the parser');
      expect(note).not.toContain('already done');
    });

    it('does not fire when maxTurns is below the length threshold', async () => {
      const provider = nEchoTurns(8);
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools: echoTools(),
        cwd: '/tmp',
        maxTurns: 8,
        turnBudgetHints: false,
        stepBackHints: false,
      });

      await loop.run([userText('a short task')]);

      for (const req of provider.requests) {
        expect(lastNote(req)).not.toMatch(/\[goal reminder\]/);
      }
    });

    it('injects goal reminder before turn-budget and step-back notes', async () => {
      const failTool: ToolSpec<unknown> = {
        name: 'boom',
        description: 'always errors',
        schema: noInput,
        readOnly: true,
        concurrencySafe: true,
        async execute() {
          return { content: 'nope', isError: true };
        },
      };
      const provider = new ScriptedProvider(
        Array.from({ length: 16 }, () => ({ toolCalls: [{ name: 'boom', input: {} }] })),
      );
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools: new ToolRegistry([failTool]),
        cwd: '/tmp',
        maxTurns: 16,
      });

      await loop.run([userText('keep going')]);

      const note = lastNote(provider.requests[15]);
      const goalAt = note.indexOf('[goal reminder]');
      const budgetAt = note.indexOf('[turn budget]');
      const stepAt = note.indexOf('[step back]');
      expect(goalAt).toBeGreaterThanOrEqual(0);
      expect(budgetAt).toBeGreaterThan(goalAt);
      expect(stepAt).toBeGreaterThan(budgetAt);
    });
  });

  describe('varyObservations', () => {
    it('leaves tool results unchanged by default', async () => {
      const provider = new ScriptedProvider([
        { toolCalls: [{ name: 'echo', input: {}, id: 'call_a' }] },
        { text: 'done' },
      ]);
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools: new ToolRegistry([
          trackingTool({ name: 'echo', readOnly: true, concurrencySafe: true, delayMs: 0 }),
        ]),
        cwd: '/tmp',
      });
      const result = await loop.run([userText('hi')]);
      const block = result.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result');
      expect(block).toMatchObject({ content: 'echo ran' });
    });

    it('wraps successful new results when enabled, leaving errors alone', async () => {
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            { name: 'echo', input: {}, id: 'call_ok' },
            { name: 'boom', input: {}, id: 'call_err' },
          ],
        },
        { text: 'done' },
      ]);
      const boom: ToolSpec<unknown> = {
        name: 'boom',
        description: 'errors',
        schema: noInput,
        readOnly: true,
        concurrencySafe: true,
        async execute() {
          return { content: 'nope', isError: true };
        },
      };
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools: new ToolRegistry([
          trackingTool({ name: 'echo', readOnly: true, concurrencySafe: true, delayMs: 0 }),
          boom,
        ]),
        cwd: '/tmp',
        varyObservations: true,
      });
      const result = await loop.run([userText('hi')]);
      const blocks = result.messages
        .flatMap((m) => m.content)
        .filter((b) => b.type === 'tool_result') as Array<{ content: string; isError?: boolean }>;
      const ok = blocks.find((b) => !b.isError);
      const err = blocks.find((b) => b.isError);
      expect(ok?.content).toContain('echo ran');
      expect(err?.content).toBe('nope');
    });
  });

  describe('argument robustness', () => {
    function typedTool(onRun: (input: unknown) => void): ToolSpec<unknown> {
      return {
        name: 'typed',
        description: 'a tool with a typed schema',
        schema: z.object({ recursive: z.boolean(), limit: z.number() }),
        readOnly: true,
        concurrencySafe: true,
        async execute(input) {
          onRun(input);
          return { content: 'ok' };
        },
      };
    }

    it('coerces stringified scalars from a weak model and runs the tool once', async () => {
      const provider = new ScriptedProvider([
        { toolCalls: [{ name: 'typed', input: { recursive: 'true', limit: '5' } }] },
        { text: 'done' },
      ]);
      let seen: unknown;
      const tools = new ToolRegistry([typedTool((input) => (seen = input))]);
      const loop = new AgentLoop({ model: resolvedModel(provider), tools, cwd: '/tmp' });

      const result = await loop.run([userText('hi')]);

      expect(seen).toEqual({ recursive: true, limit: 5 });
      expect(result.messages[2]?.content[0]).toMatchObject({
        type: 'tool_result',
        content: 'ok',
      });
      expect(result.messages[2]?.content[0]).not.toHaveProperty('isError', true);
    });

    it('returns a prettified error and the expected schema when args are unfixable', async () => {
      const provider = new ScriptedProvider([
        { toolCalls: [{ name: 'typed', input: { recursive: 'maybe', limit: 'lots' } }] },
        { text: 'done' },
      ]);
      const tools = new ToolRegistry([typedTool(() => {})]);
      const loop = new AgentLoop({ model: resolvedModel(provider), tools, cwd: '/tmp' });

      const result = await loop.run([userText('hi')]);

      const block = result.messages[2]?.content[0] as { content: string; isError?: boolean };
      expect(block.isError).toBe(true);
      expect(block.content).toContain('Invalid arguments for typed');
      // prettified, human-readable issue list rather than the raw zod dump
      expect(block.content).toContain('recursive');
      // the schema is echoed so the model can self-correct
      expect(block.content).toContain('Expected schema:');
      expect(block.content).toContain('boolean');
    });
  });

  describe('read dedup within a batch', () => {
    function countingRead(counter: { runs: number }): ToolSpec<unknown> {
      return {
        name: 'read',
        description: 'read-only, concurrency-safe',
        schema: z.object({ path: z.string() }),
        readOnly: true,
        concurrencySafe: true,
        async execute(input) {
          counter.runs++;
          await delay(10);
          return { content: `read ${(input as { path: string }).path}` };
        },
      };
    }

    it('runs identical read-only calls once but returns a result for each', async () => {
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            { name: 'read', input: { path: 'a.ts' } },
            { name: 'read', input: { path: 'a.ts' } },
            { name: 'read', input: { path: 'b.ts' } },
          ],
        },
        { text: 'done' },
      ]);
      const counter = { runs: 0 };
      const tools = new ToolRegistry([countingRead(counter)]);
      const loop = new AgentLoop({ model: resolvedModel(provider), tools, cwd: '/tmp' });

      const result = await loop.run([userText('hi')]);

      // two distinct signatures → two executions, not three
      expect(counter.runs).toBe(2);
      const blocks = result.messages
        .flatMap((m) => m.content)
        .filter((b) => b.type === 'tool_result') as Array<{ content: string }>;
      expect(blocks).toHaveLength(3);
      expect(blocks[0]?.content).toBe('read a.ts');
      expect(blocks[1]?.content).toBe('read a.ts');
      expect(blocks[2]?.content).toBe('read b.ts');
    });

    it('does not dedup identical calls to a non-read-only tool', async () => {
      const counter = { runs: 0 };
      const write: ToolSpec<unknown> = {
        name: 'write',
        description: 'not read-only',
        schema: z.object({ path: z.string() }),
        readOnly: false,
        concurrencySafe: false,
        async execute() {
          counter.runs++;
          return { content: 'wrote' };
        },
      };
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            { name: 'write', input: { path: 'a.ts' } },
            { name: 'write', input: { path: 'a.ts' } },
          ],
        },
        { text: 'done' },
      ]);
      const loop = new AgentLoop({
        model: resolvedModel(provider),
        tools: new ToolRegistry([write]),
        cwd: '/tmp',
      });

      await loop.run([userText('hi')]);

      expect(counter.runs).toBe(2);
    });
  });
});
