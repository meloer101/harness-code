/**
 * Server-Sent Events reader.
 *
 * Written by hand rather than pulled from a dependency because the endpoints we
 * target break the spec in small ways we need to absorb: bare `\r` line
 * endings, `data:` with no space, keep-alive comment lines, multi-line `data:`
 * payloads, and a `[DONE]` sentinel that is not part of SSE at all.
 */

export interface SSEMessage {
  event: string | undefined;
  data: string;
  id: string | undefined;
}

export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEMessage> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = '';

  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Normalize line endings so a single split rule works everywhere.
      buffer = buffer.replace(/\r\n|\r/g, '\n');

      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const msg = parseChunk(chunk);
        if (msg) yield msg;
      }
    }

    // Flush a trailing event that never got its blank-line terminator.
    buffer += decoder.decode();
    const tail = parseChunk(buffer.replace(/\r\n|\r/g, '\n'));
    if (tail) yield tail;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock?.();
  }
}

function parseChunk(chunk: string): SSEMessage | undefined {
  if (!chunk.trim()) return undefined;

  let event: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of chunk.split('\n')) {
    if (!line || line.startsWith(':')) continue; // keep-alive / comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'data':
        dataLines.push(value);
        break;
      case 'event':
        event = value;
        break;
      case 'id':
        id = value;
        break;
      default:
        break; // `retry` and unknown fields are not our problem
    }
  }

  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join('\n'), id };
}
