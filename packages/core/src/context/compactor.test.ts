import { describe, expect, it } from 'vitest';

import { ScriptedProvider } from '../provider/mock.js';
import type { Message } from '../provider/types.js';
import {
  COMPACTION_MARKER,
  compactMessages,
  createCompactor,
  parseGoalAndPriorDigest,
  splitForCompaction,
} from './compactor.js';

const goal = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });

/** One turn: assistant asks for a tool, user returns the result. */
function toolTurn(n: number): Message[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `c${n}`, name: 'read', input: { path: `f${n}.ts` } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: `c${n}`, content: `contents of f${n}.ts` }],
    },
  ];
}

function history(turns: number): Message[] {
  const msgs: Message[] = [goal('fix the parser bug')];
  for (let i = 1; i <= turns; i++) msgs.push(...toolTurn(i));
  return msgs;
}

const ctx = { turn: 1, cwd: '/tmp' };

describe('splitForCompaction', () => {
  it('cuts on turn boundaries, keeping the last N turns', () => {
    const split = splitForCompaction(history(10), 3);
    expect(split).toBeDefined();
    expect(split!.keptTurns).toBe(3);
    // 3 kept turns * 2 messages each
    expect(split!.tail).toHaveLength(6);
    expect(split!.tail[0]?.role).toBe('assistant');
    expect(split!.middle).toHaveLength((10 - 3) * 2);
  });

  it('never splits an assistant tool_use from its tool_result', () => {
    const split = splitForCompaction(history(8), 3)!;
    for (const seg of [split.middle, split.tail]) {
      for (let i = 0; i < seg.length; i++) {
        const uses = seg[i]?.content.filter((b) => b.type === 'tool_use') ?? [];
        if (uses.length > 0) {
          const next = seg[i + 1];
          expect(next?.content.some((b) => b.type === 'tool_result')).toBe(true);
        }
      }
    }
  });

  it('returns undefined when there are not enough turns', () => {
    expect(splitForCompaction(history(3), 3)).toBeUndefined();
    expect(splitForCompaction([goal('hi')], 3)).toBeUndefined();
  });

  it('keeps a fresh user prompt as its own turn boundary', () => {
    const msgs: Message[] = [
      goal('first task'),
      ...toolTurn(1),
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      goal('second task'),
      ...toolTurn(2),
      ...toolTurn(3),
      ...toolTurn(4),
    ];
    const split = splitForCompaction(msgs, 3)!;
    // "second task" is the 4th-from-last group, so it lands in middle, not tail
    expect(split.tail[0]?.role).toBe('assistant');
    expect(split.middle.some((m) => m.content.some((b) => b.type === 'text' && b.text === 'second task'))).toBe(true);
  });
});

describe('compactMessages / parseGoalAndPriorDigest', () => {
  it('merges the verbatim goal and digest into one head, then the tail', () => {
    const tail = [...toolTurn(9), ...toolTurn(10)];
    const out = compactMessages('fix the parser bug', 'DIGEST BODY', tail);
    expect(out).toHaveLength(1 + tail.length);
    const headText = out[0]?.content[0];
    expect(headText).toMatchObject({ type: 'text' });
    expect((headText as { text: string }).text).toContain('fix the parser bug');
    expect((headText as { text: string }).text).toContain('DIGEST BODY');
    expect(out[1]).toEqual(tail[0]);
  });

  it('round-trips the goal and prior digest back out of a compacted head', () => {
    const head = compactMessages('original goal', 'prior digest text', [])[0]!;
    const parsed = parseGoalAndPriorDigest(head);
    expect(parsed.goal.trim()).toBe('original goal');
    expect(parsed.priorDigest?.trim()).toBe('prior digest text');
  });

  it('treats an uncompacted head as goal-only', () => {
    expect(parseGoalAndPriorDigest(goal('just a goal'))).toEqual({ goal: 'just a goal' });
  });
});

describe('createCompactor', () => {
  it('summarizes the middle and returns [head+digest, ...tail]', async () => {
    const provider = new ScriptedProvider([{ text: '## 任务状态\n- 原始目标：fix the parser bug\n## 协作与风格备忘\n- 与用户协作：无偏差' }]);
    const onCompact = createCompactor({
      provider,
      model: 'm',
      conventions: '<code_style>baseline</code_style>',
      minCompactTokens: 0,
    });

    const result = await onCompact(history(10), { usedTokens: 1, windowTokens: 1, ratio: 1 }, ctx);

    expect(result).toBeDefined();
    expect(result!.keptTurns).toBe(3);
    expect(result!.messages).toHaveLength(1 + 6);
    const headText = (result!.messages[0]?.content[0] as { text: string }).text;
    expect(headText).toContain('fix the parser bug');
    expect(headText).toContain('协作与风格备忘');
    expect(headText.includes(COMPACTION_MARKER.trim())).toBe(true);
    expect(provider.requests[0]?.messages[0]?.content[0]).toMatchObject({ type: 'text' });
  });

  it('feeds the prior digest back in on a second compaction', async () => {
    const provider = new ScriptedProvider([
      { text: 'digest v1' },
      { text: 'digest v2' },
    ]);
    const onCompact = createCompactor({ provider, model: 'm', conventions: 'c', minCompactTokens: 0 });

    const first = await onCompact(history(10), { usedTokens: 1, windowTokens: 1, ratio: 1 }, ctx);
    const grown = [...first!.messages, ...toolTurn(11), ...toolTurn(12), ...toolTurn(13), ...toolTurn(14)];
    await onCompact(grown, { usedTokens: 1, windowTokens: 1, ratio: 1 }, ctx);

    const secondPrompt = (provider.requests[1]?.messages[0]?.content[0] as { text: string }).text;
    expect(secondPrompt).toContain('digest v1');
  });

  it('returns undefined (never throws) when the summarizer fails', async () => {
    const provider = new ScriptedProvider([]); // out of turns -> throws
    const skips: string[] = [];
    const onCompact = createCompactor({
      provider,
      model: 'm',
      conventions: 'c',
      minCompactTokens: 0,
      onSkip: (r) => skips.push(r),
    });

    const result = await onCompact(history(10), { usedTokens: 1, windowTokens: 1, ratio: 1 }, ctx);

    expect(result).toBeUndefined();
    expect(skips[0]).toContain('compaction skipped');
  });

  it('skips when the compactable history is below the minimum', async () => {
    const provider = new ScriptedProvider([{ text: 'unreached' }]);
    const onCompact = createCompactor({ provider, model: 'm', conventions: 'c', minCompactTokens: 1_000_000 });

    const result = await onCompact(history(10), { usedTokens: 1, windowTokens: 1, ratio: 1 }, ctx);

    expect(result).toBeUndefined();
    expect(provider.callCount).toBe(0);
  });
});
