import { describe, expect, it } from 'vitest';

import { parseSSE } from './sse.js';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out = [];
  for await (const msg of parseSSE(stream)) out.push(msg);
  return out;
}

describe('parseSSE', () => {
  it('reads well-formed frames', async () => {
    const msgs = await collect(streamOf('data: {"a":1}\n\n', 'data: [DONE]\n\n'));
    expect(msgs.map((m) => m.data)).toEqual(['{"a":1}', '[DONE]']);
  });

  it('reassembles a frame split across network chunks', async () => {
    const msgs = await collect(streamOf('data: {"a', '":1}\n', '\ndata: {"b":2}\n\n'));
    expect(msgs.map((m) => m.data)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('handles CRLF line endings', async () => {
    const msgs = await collect(streamOf('data: {"a":1}\r\n\r\n'));
    expect(msgs.map((m) => m.data)).toEqual(['{"a":1}']);
  });

  it('accepts data with no space after the colon', async () => {
    const msgs = await collect(streamOf('data:{"a":1}\n\n'));
    expect(msgs.map((m) => m.data)).toEqual(['{"a":1}']);
  });

  it('skips keep-alive comment lines', async () => {
    const msgs = await collect(streamOf(': ping\n\n', 'data: {"a":1}\n\n'));
    expect(msgs.map((m) => m.data)).toEqual(['{"a":1}']);
  });

  it('joins multi-line data payloads', async () => {
    const msgs = await collect(streamOf('data: line1\ndata: line2\n\n'));
    expect(msgs[0]?.data).toBe('line1\nline2');
  });

  it('reads event and id fields', async () => {
    const msgs = await collect(streamOf('event: delta\nid: 7\ndata: {}\n\n'));
    expect(msgs[0]).toMatchObject({ event: 'delta', id: '7', data: '{}' });
  });

  it('flushes a final frame that never got its blank line', async () => {
    const msgs = await collect(streamOf('data: {"a":1}'));
    expect(msgs.map((m) => m.data)).toEqual(['{"a":1}']);
  });
});
