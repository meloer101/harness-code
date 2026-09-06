/**
 * Test doubles: scripted, recording and replay providers.
 *
 * Determinism is a prerequisite for the eval harness, not a testing nicety. A
 * benchmark you cannot re-run identically tells you nothing about whether last
 * week's change helped. So every real call can be recorded once and replayed
 * forever, and CI never spends money or depends on someone else's uptime.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { stableStringify } from '../util/json.js';
import { heuristicTokenCount } from './openai-compat.js';
import { ProviderError, drainStream, emptyUsage } from './types.js';
import type {
  AssistantBlock,
  ModelRequest,
  ModelResponse,
  Provider,
  StopReason,
  StreamEvent,
  ToolUseBlock,
} from './types.js';

// ---------------------------------------------------------------------------
// Scripted provider
// ---------------------------------------------------------------------------

export interface ScriptedTurn {
  text?: string;
  thinking?: string;
  toolCalls?: Array<{ name: string; input: unknown; id?: string }>;
  stopReason?: StopReason;
  /** Split `text` into this many deltas, to exercise streaming consumers. */
  chunkSize?: number;
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
}

/**
 * Returns pre-written turns in order. The workhorse for agent-loop tests: it
 * lets a test say "the model asks for `read`, then answers" without inventing
 * a transport.
 */
export class ScriptedProvider implements Provider {
  readonly id: string;
  /** Every request this provider was given, in order. Assert against it. */
  readonly requests: ModelRequest[] = [];
  private cursor = 0;

  constructor(
    private readonly turns: readonly ScriptedTurn[],
    id = 'scripted',
  ) {
    this.id = id;
  }

  get callCount(): number {
    return this.cursor;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    return drainStream(this.stream(req));
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    const turn = this.turns[this.cursor];
    if (!turn) {
      throw new ProviderError(
        'protocol',
        `ScriptedProvider ran out of turns after ${this.cursor} call(s). ` +
          `The code under test called the model more times than the script expects.`,
      );
    }
    this.cursor++;

    if (req.signal?.aborted) {
      throw new ProviderError('aborted', 'Request aborted', { retryable: false });
    }

    yield { type: 'message_start', model: req.model };

    if (turn.thinking) {
      yield { type: 'thinking_delta', text: turn.thinking };
    }

    const text = turn.text ?? '';
    if (text !== '') {
      for (const piece of chunk(text, turn.chunkSize ?? text.length)) {
        yield { type: 'text_delta', text: piece };
      }
    }

    const toolBlocks: ToolUseBlock[] = [];
    (turn.toolCalls ?? []).forEach((call, index) => {
      const block: ToolUseBlock = {
        type: 'tool_use',
        id: call.id ?? `call_${this.cursor}_${index}`,
        name: call.name,
        input: call.input,
        rawInput: JSON.stringify(call.input),
      };
      toolBlocks.push(block);
    });

    for (const [index, block] of toolBlocks.entries()) {
      yield { type: 'tool_use_start', index, id: block.id, name: block.name };
      yield { type: 'tool_use_delta', index, argsDelta: block.rawInput ?? '{}' };
      yield { type: 'tool_use_end', index, block };
    }

    const content: AssistantBlock[] = [];
    if (turn.thinking) content.push({ type: 'thinking', text: turn.thinking });
    if (text !== '') content.push({ type: 'text', text });
    content.push(...toolBlocks);

    yield {
      type: 'message_end',
      response: {
        model: req.model,
        content,
        stopReason: turn.stopReason ?? (toolBlocks.length > 0 ? 'tool_use' : 'end_turn'),
        usage: {
          ...emptyUsage(),
          inputTokens: turn.usage?.inputTokens ?? estimateRequestTokens(req),
          outputTokens: turn.usage?.outputTokens ?? heuristicTokenCount(text),
          cachedInputTokens: turn.usage?.cachedInputTokens ?? 0,
          estimated: true,
        },
        latencyMs: 0,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Record / replay
// ---------------------------------------------------------------------------

export interface CassetteEntry {
  key: string;
  /** Human-readable summary so a fixture diff is reviewable. */
  note: string;
  events: StreamEvent[];
}

/**
 * A request fingerprint. Deliberately excludes anything non-deterministic
 * (`signal`, timing) and anything that does not change the model's answer.
 */
export function requestKey(req: ModelRequest): string {
  const normalized = {
    model: req.model,
    system: (req.system ?? []).map((s) => s.text),
    messages: req.messages,
    tools: (req.tools ?? []).map((t) => ({ name: t.name, schema: t.inputSchema })),
    toolChoice: req.toolChoice ?? 'auto',
    temperature: req.temperature ?? null,
  };
  return createHash('sha256').update(stableStringify(normalized)).digest('hex').slice(0, 32);
}

/** Wraps a live provider and appends every exchange to a cassette file. */
export class RecordingProvider implements Provider {
  readonly id: string;

  constructor(
    private readonly inner: Provider,
    private readonly cassettePath: string,
  ) {
    this.id = inner.id;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    return drainStream(this.stream(req));
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    const events: StreamEvent[] = [];
    for await (const ev of this.inner.stream(req)) {
      events.push(ev);
      yield ev;
    }
    await this.append({ key: requestKey(req), note: summarize(req), events });
  }

  private async append(entry: CassetteEntry): Promise<void> {
    await mkdir(dirname(this.cassettePath), { recursive: true });
    await appendFile(this.cassettePath, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

export interface ReplayOptions {
  /**
   * When a request has no recording, fall back to sequential playback of
   * whatever is left. Off by default: a silent mismatch is how a "passing"
   * eval ends up measuring nothing.
   */
  allowSequentialFallback?: boolean;
}

/** Serves recorded exchanges. Nothing leaves the machine. */
export class ReplayProvider implements Provider {
  readonly id = 'replay';
  private readonly byKey = new Map<string, CassetteEntry[]>();
  private readonly order: CassetteEntry[] = [];
  private sequentialCursor = 0;

  private constructor(
    entries: readonly CassetteEntry[],
    private readonly opts: ReplayOptions,
  ) {
    for (const entry of entries) {
      this.order.push(entry);
      const bucket = this.byKey.get(entry.key);
      if (bucket) bucket.push(entry);
      else this.byKey.set(entry.key, [entry]);
    }
  }

  static async load(path: string, opts: ReplayOptions = {}): Promise<ReplayProvider> {
    const raw = await readFile(path, 'utf8');
    const entries = raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as CassetteEntry);
    return new ReplayProvider(entries, opts);
  }

  static fromEntries(
    entries: readonly CassetteEntry[],
    opts: ReplayOptions = {},
  ): ReplayProvider {
    return new ReplayProvider(entries, opts);
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    return drainStream(this.stream(req));
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    const key = requestKey(req);
    const bucket = this.byKey.get(key);
    let entry = bucket?.shift();

    if (!entry && this.opts.allowSequentialFallback) {
      entry = this.order[this.sequentialCursor++];
    }
    if (!entry) {
      throw new ProviderError(
        'not_found',
        `No recorded response for request ${key}. Re-record the cassette, or the ` +
          `prompt changed since it was made (${summarize(req)}).`,
      );
    }

    for (const ev of entry.events) yield ev;
  }
}

// ---------------------------------------------------------------------------
// HTTP-level doubles, for testing the OpenAI adapter itself
// ---------------------------------------------------------------------------

/** Build a `fetch` that returns these SSE frames as one streamed response. */
export function sseFetch(
  frames: readonly string[],
  init: { status?: number; headers?: Record<string, string> } = {},
): typeof fetch {
  return (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    return new Response(body, {
      status: init.status ?? 200,
      headers: { 'content-type': 'text/event-stream', ...(init.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
}

/** Turn chunk objects into properly framed `data:` lines plus `[DONE]`. */
export function sseFrames(chunks: readonly unknown[], done = true): string[] {
  const frames = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  if (done) frames.push('data: [DONE]\n\n');
  return frames;
}

/** Build a `fetch` returning a single JSON response, for non-streaming paths. */
export function jsonFetch(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------

function chunk(text: string, size: number): string[] {
  if (size <= 0 || size >= text.length) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function summarize(req: ModelRequest): string {
  const last = req.messages[req.messages.length - 1];
  const preview =
    last?.content
      .map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? b.content : ''))
      .join(' ')
      .slice(0, 80) ?? '';
  return `${req.model} <- ${req.messages.length} msg: ${preview.replace(/\s+/g, ' ')}`;
}

function estimateRequestTokens(req: ModelRequest): number {
  const text =
    (req.system ?? []).map((s) => s.text).join('') +
    req.messages
      .map((m) =>
        m.content
          .map((b) =>
            b.type === 'text' || b.type === 'thinking'
              ? b.text
              : b.type === 'tool_result'
                ? b.content
                : JSON.stringify(b.input),
          )
          .join(''),
      )
      .join('');
  return heuristicTokenCount(text);
}
