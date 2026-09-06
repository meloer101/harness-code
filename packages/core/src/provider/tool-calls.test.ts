import { describe, expect, it } from 'vitest';

import { ToolCallAccumulator } from './openai-compat.js';
import type { OpenAIToolCallDelta } from './openai-compat.js';
import type { StreamEvent, ToolUseBlock } from './types.js';

function run(chunks: OpenAIToolCallDelta[][]): {
  events: StreamEvent[];
  blocks: ToolUseBlock[];
} {
  const acc = new ToolCallAccumulator();
  const events: StreamEvent[] = [];
  for (const chunk of chunks) events.push(...acc.push(chunk));
  const finalized = acc.finalize();
  events.push(...finalized.map((f) => ({ type: 'tool_use_end' as const, ...f })));
  return { events, blocks: finalized.map((f) => f.block) };
}

describe('ToolCallAccumulator', () => {
  // Shape A: OpenAI proper. Stable index, id and name on the opening delta,
  // arguments streamed character-group by character-group.
  it('assembles OpenAI-shaped deltas with a stable index', () => {
    const { events, blocks } = run([
      [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'read', arguments: '' } }],
      [{ index: 0, function: { arguments: '{"pa' } }],
      [{ index: 0, function: { arguments: 'th":"a.ts"' } }],
      [{ index: 0, function: { arguments: '}' } }],
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ id: 'call_abc', name: 'read', input: { path: 'a.ts' } });
    expect(events[0]).toEqual({
      type: 'tool_use_start',
      index: 0,
      id: 'call_abc',
      name: 'read',
    });
    expect(events.filter((e) => e.type === 'tool_use_delta')).toHaveLength(3);
  });

  // Shape B: no `index` field at all. Seen on several self-hosted shims. The
  // continuation deltas carry nothing but an argument fragment.
  it('assembles deltas that omit index entirely', () => {
    const { blocks } = run([
      [{ id: 'call_1', function: { name: 'grep', arguments: '{"pattern":' } }],
      [{ function: { arguments: '"TODO",' } }],
      [{ function: { arguments: '"path":"src"}' } }],
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      id: 'call_1',
      name: 'grep',
      input: { pattern: 'TODO', path: 'src' },
    });
  });

  // Shape C: the entire call, or several calls, delivered in one chunk.
  it('assembles calls delivered whole in a single chunk', () => {
    const { blocks } = run([
      [
        { index: 0, id: 'a', function: { name: 'read', arguments: '{"path":"a.ts"}' } },
        { index: 1, id: 'b', function: { name: 'read', arguments: '{"path":"b.ts"}' } },
      ],
    ]);

    expect(blocks.map((b) => b.name)).toEqual(['read', 'read']);
    expect(blocks.map((b) => b.input)).toEqual([{ path: 'a.ts' }, { path: 'b.ts' }]);
  });

  it('keeps parallel calls separate when their deltas interleave', () => {
    const { blocks } = run([
      [{ index: 0, id: 'a', function: { name: 'read', arguments: '{"path":' } }],
      [{ index: 1, id: 'b', function: { name: 'grep', arguments: '{"pattern":' } }],
      [{ index: 0, function: { arguments: '"a.ts"}' } }],
      [{ index: 1, function: { arguments: '"x"}' } }],
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ name: 'read', input: { path: 'a.ts' } });
    expect(blocks[1]).toMatchObject({ name: 'grep', input: { pattern: 'x' } });
  });

  it('does not concatenate a name that is repeated in every delta', () => {
    const { blocks } = run([
      [{ index: 0, id: 'a', function: { name: 'bash', arguments: '{"cmd"' } }],
      [{ index: 0, function: { name: 'bash', arguments: ':"ls"}' } }],
    ]);

    expect(blocks[0]?.name).toBe('bash');
  });

  it('joins a name that is genuinely split across deltas', () => {
    const { blocks } = run([
      [{ index: 0, id: 'a', function: { name: 'ba' } }],
      [{ index: 0, function: { name: 'sh', arguments: '{}' } }],
    ]);

    expect(blocks[0]?.name).toBe('bash');
  });

  it('starts a new call when an un-indexed delta brings a different name', () => {
    const { blocks } = run([
      [{ function: { name: 'read', arguments: '{"path":"a.ts"}' } }],
      [{ function: { name: 'write', arguments: '{"path":"b.ts"}' } }],
    ]);

    expect(blocks.map((b) => b.name)).toEqual(['read', 'write']);
  });

  it('synthesizes an id when the endpoint never sends one', () => {
    const { blocks } = run([[{ index: 0, function: { name: 'read', arguments: '{}' } }]]);
    expect(blocks[0]?.id).toBe('call_0');
  });

  it('surfaces a parse error rather than dropping an unparseable call', () => {
    const { blocks } = run([
      [{ index: 0, id: 'a', function: { name: 'read', arguments: 'definitely not json' } }],
    ]);

    expect(blocks[0]?.parseError).toBeDefined();
    expect(blocks[0]?.rawInput).toBe('definitely not json');
    expect(blocks[0]?.input).toEqual({});
  });

  it('recovers arguments truncated by max_tokens', () => {
    const { blocks } = run([
      [{ index: 0, id: 'a', function: { name: 'write', arguments: '{"path":"a.ts","body":"he' } }],
    ]);

    expect(blocks[0]?.parseError).toBeUndefined();
    expect(blocks[0]?.input).toEqual({ path: 'a.ts', body: 'he' });
  });

  it('emits tool_use_start only once a name is known', () => {
    const acc = new ToolCallAccumulator();
    const first = acc.push([{ index: 0, id: 'a', function: { arguments: '{}' } }]);
    expect(first.filter((e) => e.type === 'tool_use_start')).toHaveLength(0);

    const second = acc.push([{ index: 0, function: { name: 'read' } }]);
    expect(second[0]).toMatchObject({ type: 'tool_use_start', name: 'read' });
  });
});
