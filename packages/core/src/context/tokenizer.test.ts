import { describe, expect, it } from 'vitest';

import { OpenAICompatProvider } from '../provider/openai-compat.js';
import { jsonFetch } from '../provider/mock.js';
import type { ModelRequest } from '../provider/types.js';
import {
  estimateMessageTokens,
  estimateRequestTokens,
  flattenRequestText,
  heuristicTokenCount,
  createTokenCalibrator,
} from './tokenizer.js';

describe('heuristicTokenCount', () => {
  it('counts nothing for the empty string', () => {
    expect(heuristicTokenCount('')).toBe(0);
  });

  it('weights CJK more densely than ASCII of the same length', () => {
    expect(heuristicTokenCount('中'.repeat(100))).toBeGreaterThan(heuristicTokenCount('a'.repeat(100)));
  });

  it('handles a realistic mixed CJK/ASCII string without collapsing to 1', () => {
    const n = heuristicTokenCount('给 read.ts 的分页加边界处理 and write a test');
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThan(60);
  });
});

describe('flattenRequestText', () => {
  const req: ModelRequest = {
    model: 'm',
    system: [{ id: 's', text: 'SYSTEM PROMPT' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'a.ts' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 't1', content: 'FILE BODY' }],
      },
    ],
    tools: [{ name: 'read', description: 'reads a file', inputSchema: { type: 'object' } }],
  };

  it('includes system text, every message kind, and tool schemas', () => {
    const flat = flattenRequestText(req);
    expect(flat).toContain('SYSTEM PROMPT');
    expect(flat).toContain('hello');
    expect(flat).toContain('a.ts');
    expect(flat).toContain('FILE BODY');
    expect(flat).toContain('reads a file');
  });

  it('matches the provider-side estimate (refactor kept the semantics)', async () => {
    // The provider's estimateUsage path (used when the endpoint reports no usage)
    // must agree with the loop's estimate — both go through flattenRequestText now.
    const provider = new OpenAICompatProvider({
      id: 'x',
      baseUrl: 'https://e.test/v1',
      apiKey: 'k',
      // Non-streaming so a plain JSON body (no `usage`) exercises estimateUsage.
      capabilityOverrides: { '*': { streaming: false } },
      fetchImpl: jsonFetch({
        model: 'm',
        choices: [{ finish_reason: 'stop', message: { content: '' } }],
      }),
      maxRetries: 0,
    });
    const res = await provider.complete(req);
    expect(res.usage.estimated).toBe(true);
    expect(res.usage.inputTokens).toBe(estimateRequestTokens(req));
  });
});

describe('estimateMessageTokens', () => {
  it('scales with how much was appended', () => {
    const small = estimateMessageTokens([
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't', content: 'ok' }] },
    ]);
    const big = estimateMessageTokens([
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 't', content: 'x'.repeat(4000) }],
      },
    ]);
    expect(big).toBeGreaterThan(small + 100);
  });
});

describe('createTokenCalibrator', () => {
  it('matches the heuristic on a cold start', () => {
    const cal = createTokenCalibrator();
    const text = 'give read.ts a pagination bound and write a test';
    expect(cal.count(text)).toBe(heuristicTokenCount(text));
    expect(cal.count('')).toBe(0);
  });

  it('reduces mean relative error after observing a systematic bias', () => {
    const text = 'hello world '.repeat(40);
    const heuristic = heuristicTokenCount(text);
    const actual = heuristic * 2;
    const cal = createTokenCalibrator({ alpha: 0.5 });
    const errBefore = Math.abs(cal.count(text) - actual) / actual;
    for (let i = 0; i < 8; i++) cal.observe(heuristic, actual);
    const errAfter = Math.abs(cal.count(text) - actual) / actual;
    expect(errAfter).toBeLessThan(errBefore);
    expect(errAfter).toBeLessThan(0.05);
  });

  it('clamps the scale so one outlier cannot double-count forever', () => {
    const cal = createTokenCalibrator({ alpha: 1 });
    cal.observe(100, 10_000);
    const text = 'abcd'.repeat(25);
    expect(cal.count(text)).toBe(Math.round(heuristicTokenCount(text) * 2));
    cal.observe(100, 1);
    expect(cal.count(text)).toBe(Math.round(heuristicTokenCount(text) * 0.5));
  });

  it('ignores a zero estimated or actual sample', () => {
    const cal = createTokenCalibrator({ alpha: 1 });
    cal.observe(0, 100);
    cal.observe(50, 0);
    const text = 'abcd'.repeat(25);
    expect(cal.count(text)).toBe(heuristicTokenCount(text));
  });
});
