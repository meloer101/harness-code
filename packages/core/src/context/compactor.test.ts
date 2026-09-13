import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScriptedProvider } from '../provider/mock.js';
import type { Message } from '../provider/types.js';
import {
  COMPACTION_MARKER,
  PRUNED_TOOL_RESULT_PREFIX,
  applyToolOutputOffload,
  compactMessages,
  createCompactor,
  ensureInvariants,
  extractCompactionInvariants,
  parseGoalAndPriorDigest,
  pruneToolOutputs,
  splitForCompaction,
} from './compactor.js';
import { heuristicTokenCount } from './tokenizer.js';

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

describe('extractCompactionInvariants / ensureInvariants', () => {
  it('picks up a user prohibition and a Denied tool_result', () => {
    const msgs: Message[] = [
      goal('fix the bug. 不要碰 secrets/'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'c1',
            content: 'Denied: path outside workspace',
            isError: true,
          },
        ],
      },
    ];
    const inv = extractCompactionInvariants(msgs);
    expect(inv.some((s) => s.includes('不要碰 secrets/'))).toBe(true);
    expect(inv.some((s) => s.startsWith('Denied:'))).toBe(true);
  });

  it('prepends missing invariants and leaves a complete digest alone', () => {
    expect(ensureInvariants('keep', [])).toBe('keep');
    expect(ensureInvariants('already 不要碰 secrets/ here', ['不要碰 secrets/'])).toBe(
      'already 不要碰 secrets/ here',
    );
    const out = ensureInvariants('## 任务状态\nok', ['不要碰 secrets/']);
    expect(out).toContain('不要碰 secrets/');
    expect(out.indexOf('不要碰 secrets/')).toBeLessThan(out.indexOf('任务状态'));
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

  it('keeps a user prohibition in the digest even when the summarizer drops it', async () => {
    const provider = new ScriptedProvider([
      { text: '## 任务状态\n- 进展：did stuff\n## 协作与风格备忘\n- 无偏差' },
    ]);
    const onCompact = createCompactor({
      provider,
      model: 'm',
      conventions: 'c',
      minCompactTokens: 0,
    });
    // Prohibition sits in the compactable middle, not the verbatim goal/tail.
    const msgs: Message[] = [
      goal('fix the parser'),
      { role: 'assistant', content: [{ type: 'text', text: 'got it' }] },
      { role: 'user', content: [{ type: 'text', text: '顺便说：不要碰 secrets/' }] },
      ...history(10).slice(1),
    ];
    const result = await onCompact(msgs, { usedTokens: 1, windowTokens: 1, ratio: 1 }, ctx);
    const headText = (result!.messages[0]?.content[0] as { text: string }).text;
    expect(headText).toContain('不要碰 secrets/');
  });

  it('returns a prune-only result when history is too short to summarize', async () => {
    // Newest result fills the protect window; the older huge one is reclaimed.
    const big = 'x'.repeat(80_000);
    const recent = 'r'.repeat(2_000);
    const msgs: Message[] = [
      goal('task'),
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'c1', name: 'bash', input: {} },
          { type: 'tool_use', id: 'c2', name: 'bash', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'c1', content: big },
          { type: 'tool_result', toolUseId: 'c2', content: recent },
        ],
      },
    ];
    const provider = new ScriptedProvider([{ text: 'should not be called' }]);
    const onCompact = createCompactor({
      provider,
      model: 'm',
      conventions: 'c',
      keepTurns: 3,
      pruneProtectTokens: heuristicTokenCount(recent),
      pruneMinReclaimTokens: 100,
    });

    const result = await onCompact(msgs, { usedTokens: 1, windowTokens: 1, ratio: 1 }, ctx);

    expect(provider.callCount).toBe(0);
    expect(result).toBeDefined();
    const results = result!.messages[2]!.content.filter((b) => b.type === 'tool_result');
    expect((results[0] as { content: string }).content).toContain(PRUNED_TOOL_RESULT_PREFIX);
    expect((results[1] as { content: string }).content).toBe(recent);
  });

  it('feeds a pruned middle to the summarizer', async () => {
    const big = 'y'.repeat(60_000);
    const msgs: Message[] = [goal('task')];
    for (let i = 1; i <= 6; i++) {
      msgs.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `c${i}`, name: 'bash', input: { i } }],
      });
      msgs.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: `c${i}`,
            // Oldest three are huge; newest three are tiny so the protect
            // window fills on the newest alone and the big ones get pruned.
            content: i <= 3 ? big : `small-${i}`,
          },
        ],
      });
    }
    const provider = new ScriptedProvider([{ text: 'digest after prune' }]);
    const onCompact = createCompactor({
      provider,
      model: 'm',
      conventions: 'c',
      keepTurns: 2,
      minCompactTokens: 0,
      // Only the newest tool_result stays; everything older (incl. the huge ones) is pruned.
      pruneProtectTokens: 1,
      pruneMinReclaimTokens: 100,
    });

    const result = await onCompact(msgs, { usedTokens: 1, windowTokens: 1, ratio: 1 }, ctx);

    expect(result).toBeDefined();
    expect(provider.callCount).toBe(1);
    const prompt = (provider.requests[0]?.messages[0]?.content[0] as { text: string }).text;
    expect(prompt).toContain(PRUNED_TOOL_RESULT_PREFIX);
    expect(prompt).not.toContain(big);
  });
});

describe('pruneToolOutputs', () => {
  it('keeps recent tool outputs and prunes older ones past the protect window', () => {
    const oldBig = 'a'.repeat(50_000);
    // Recent alone must fill the protect window so older content is pruned.
    const recent = 'b'.repeat(5_000);
    const msgs: Message[] = [
      goal('g'),
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'old', name: 'bash', input: {} },
          { type: 'tool_use', id: 'new', name: 'bash', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'old', content: oldBig },
          { type: 'tool_result', toolUseId: 'new', content: recent },
        ],
      },
    ];
    const out = pruneToolOutputs(msgs, {
      protectTokens: heuristicTokenCount(recent),
      minReclaimTokens: 100,
    });
    expect(out.reclaimedTokens).toBeGreaterThan(0);
    const results = out.messages[2]!.content.filter((b) => b.type === 'tool_result');
    expect(results[0]).toMatchObject({
      type: 'tool_result',
      content: expect.stringContaining(PRUNED_TOOL_RESULT_PREFIX),
    });
    expect(results[1]).toMatchObject({ type: 'tool_result', content: recent });
  });

  it('never prunes protected tools (skill)', () => {
    const big = 's'.repeat(50_000);
    const msgs: Message[] = [
      goal('g'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'sk', name: 'skill', input: { name: 'x' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'sk', content: big }],
      },
    ];
    const out = pruneToolOutputs(msgs, { protectTokens: 10, minReclaimTokens: 10 });
    expect(out.reclaimedTokens).toBe(0);
    expect(out.messages).toBe(msgs);
  });

  it('leaves history unchanged when reclaimable tokens are below the minimum', () => {
    const msgs: Message[] = [
      goal('g'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'c1', content: 'tiny' }],
      },
    ];
    const out = pruneToolOutputs(msgs, { protectTokens: 0, minReclaimTokens: 20_000 });
    expect(out.reclaimedTokens).toBe(0);
    expect(out.messages).toBe(msgs);
  });

  it('does not re-prune already pruned placeholders', () => {
    const placeholder = `${PRUNED_TOOL_RESULT_PREFIX} bash, 999 chars] Cleared.`;
    const msgs: Message[] = [
      goal('g'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'c1', content: placeholder }],
      },
    ];
    const out = pruneToolOutputs(msgs, { protectTokens: 0, minReclaimTokens: 1 });
    expect(out.reclaimedTokens).toBe(0);
    expect((out.messages[2]!.content[0] as { content: string }).content).toBe(placeholder);
  });

  it('reports reclaimable tokens roughly matching the cleared content', () => {
    const body = 'z'.repeat(40_000);
    const msgs: Message[] = [
      goal('g'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'read', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'c1', content: body }],
      },
    ];
    const out = pruneToolOutputs(msgs, { protectTokens: 0, minReclaimTokens: 100 });
    expect(out.reclaimedTokens).toBe(heuristicTokenCount(body));
  });
});

describe('applyToolOutputOffload', () => {
  it('writes pruned bodies to disk and points the placeholder at a readable path', async () => {
    const body = 'z'.repeat(40_000);
    const msgs: Message[] = [
      goal('g'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'read', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'c1', content: body }],
      },
    ];
    const pruned = pruneToolOutputs(msgs, { protectTokens: 0, minReclaimTokens: 100 });
    const dir = await mkdtemp(join(tmpdir(), 'hc-toolout-'));
    const cwd = join(dir, '..');
    const offloaded = await applyToolOutputOffload(pruned, { dir, cwd });

    const result = offloaded.messages[2]!.content[0] as { content: string };
    expect(result.content).toContain(PRUNED_TOOL_RESULT_PREFIX);
    expect(result.content).toMatch(/Use the read tool to retrieve the original output/);
    const match = result.content.match(/→\s+(\S+\.txt)/);
    expect(match).toBeTruthy();
    const rel = match![1]!;
    const written = await readFile(join(cwd, rel), 'utf8');
    expect(written).toBe(body);
  });

  it('falls back to the re-call placeholder when a write fails, without throwing', async () => {
    const body = 'z'.repeat(40_000);
    const msgs: Message[] = [
      goal('g'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'c1', content: body }],
      },
    ];
    const pruned = pruneToolOutputs(msgs, { protectTokens: 0, minReclaimTokens: 100 });
    const offloaded = await applyToolOutputOffload(pruned, {
      dir: '/tmp/hc-toolout-unused',
      cwd: '/tmp',
      writeFile: async () => {
        throw new Error('ENOSPC');
      },
    });

    const result = offloaded.messages[2]!.content[0] as { content: string };
    expect(result.content).toContain(PRUNED_TOOL_RESULT_PREFIX);
    expect(result.content).toMatch(/Re-call the tool/);
    expect(result.content).not.toMatch(/→/);
  });
});
