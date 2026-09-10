import { describe, expect, it } from 'vitest';

import type { ToolUseBlock } from '../provider/types.js';
import { createToolGuardrailHooks } from './guardrails.js';
import type { TurnContext } from './hooks.js';

const ctx: TurnContext = { turn: 1, cwd: '/tmp' };

function call(name: string, input: unknown, id = 'c1'): ToolUseBlock {
  return { type: 'tool_use', id, name, input };
}

describe('createToolGuardrailHooks', () => {
  it('warns on the 2nd identical failing call and blocks on the 5th', async () => {
    const hooks = createToolGuardrailHooks({
      thresholds: {
        sameCallFailWarn: 2,
        sameCallFailBlock: 5,
        sameToolFailWarn: 99,
        sameToolFailBlock: 99,
      },
    });
    const input = { command: 'false' };
    const fail = { content: 'exit 1', isError: true as const };

    // 1st fail — no warning
    expect(await hooks.onAfterToolCall?.(call('bash', input, 'a'), fail, ctx)).toBeUndefined();
    // 2nd fail — warn
    const warn = await hooks.onAfterToolCall?.(call('bash', input, 'b'), fail, ctx);
    expect(warn?.appendToResult).toMatch(/Tool loop warning: repeated failing call/);
    // 3rd, 4th — no new warn (threshold is exact match)
    expect(await hooks.onAfterToolCall?.(call('bash', input, 'c'), fail, ctx)).toBeUndefined();
    expect(await hooks.onAfterToolCall?.(call('bash', input, 'd'), fail, ctx)).toBeUndefined();
    // 5th attempt — blocked before run (4 prior failures)
    const decision = await hooks.onBeforeToolCall?.(call('bash', input, 'e'), ctx);
    expect(decision).toMatchObject({ decision: 'deny' });
    expect(decision && 'reason' in decision ? decision.reason : '').toMatch(/failed 4 times/i);
  });

  it('resets counters after a successful write-like tool', async () => {
    const hooks = createToolGuardrailHooks({
      isReadOnly: (n) => n === 'read',
      thresholds: { sameCallFailWarn: 2, sameCallFailBlock: 5 },
    });
    const input = { path: 'a.txt' };
    const fail = { content: 'err', isError: true as const };

    await hooks.onAfterToolCall?.(call('edit', input, '1'), fail, ctx);
    await hooks.onAfterToolCall?.(call('edit', input, '2'), fail, ctx);
    // Successful write resets
    expect(
      await hooks.onAfterToolCall?.(
        call('edit', input, '3'),
        { content: 'ok' },
        ctx,
      ),
    ).toBeUndefined();
    // Same failing call again — back to count 1, no warn yet
    expect(
      await hooks.onAfterToolCall?.(call('edit', input, '4'), fail, ctx),
    ).toBeUndefined();
    const warn = await hooks.onAfterToolCall?.(call('edit', input, '5'), fail, ctx);
    expect(warn?.appendToResult).toMatch(/repeated failing call/);
  });

  it('warns when a read-only tool returns the same result twice', async () => {
    const hooks = createToolGuardrailHooks({
      isReadOnly: (n) => n === 'read',
      thresholds: { sameReadWarn: 2, sameReadBlock: 5 },
    });
    const input = { path: 'a.txt' };
    const same = { content: 'file body' };

    expect(await hooks.onAfterToolCall?.(call('read', input, '1'), same, ctx)).toBeUndefined();
    const warn = await hooks.onAfterToolCall?.(call('read', input, '2'), same, ctx);
    expect(warn?.appendToResult).toMatch(/unchanging read/);

    // Drive count to 4, then the 5th attempt is blocked
    await hooks.onAfterToolCall?.(call('read', input, '3'), same, ctx);
    await hooks.onAfterToolCall?.(call('read', input, '4'), same, ctx);
    const decision = await hooks.onBeforeToolCall?.(call('read', input, '5'), ctx);
    expect(decision?.decision).toBe('deny');
  });

  it('warns on same-tool failures across different arguments', async () => {
    const hooks = createToolGuardrailHooks({
      thresholds: { sameToolFailWarn: 3, sameToolFailBlock: 8, sameCallFailWarn: 99 },
    });
    const fail = { content: 'err', isError: true as const };

    await hooks.onAfterToolCall?.(call('bash', { command: 'a' }, '1'), fail, ctx);
    await hooks.onAfterToolCall?.(call('bash', { command: 'b' }, '2'), fail, ctx);
    const warn = await hooks.onAfterToolCall?.(call('bash', { command: 'c' }, '3'), fail, ctx);
    expect(warn?.appendToResult).toMatch(/repeated tool failures/);
  });
});
