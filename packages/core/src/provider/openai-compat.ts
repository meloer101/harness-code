/**
 * OpenAI Chat Completions provider.
 *
 * This one adapter is the substrate for DeepSeek, Moonshot/Kimi, Qwen via
 * DashScope, Zhipu, OpenRouter, Groq, Together, xAI, Mistral, a LiteLLM proxy,
 * Ollama, vLLM and llama.cpp. They all claim the same API; they differ in ways
 * that only show up in production. The differences absorbed here are documented
 * inline, because each one is a bug someone will otherwise rediscover.
 */

import { estimateCostUSD, resolveCapabilities } from './capabilities.js';
import type { CapabilityOverrides, ModelCapabilities } from './capabilities.js';
import { flattenRequestText, heuristicTokenCount } from '../context/tokenizer.js';
import type { TokenCounter } from '../context/tokenizer.js';
import { PromptToolParser, renderToolPrompt } from './prompt-tools.js';
import { parseSSE } from './sse.js';
import { parseLooseJSON } from '../util/json.js';
import {
  ProviderError,
  drainStream,
  emptyUsage,
} from './types.js';
import type {
  AssistantBlock,
  Message,
  ModelRequest,
  ModelResponse,
  Provider,
  StopReason,
  StreamEvent,
  SystemSegment,
  ToolDefinition,
  ToolUseBlock,
  Usage,
} from './types.js';

export type { TokenCounter } from '../context/tokenizer.js';

export interface OpenAICompatConfig {
  /** Routing id (`deepseek`, `ollama`, ...). Also used in error messages. */
  id: string;
  /** Base URL including the version segment, e.g. `https://api.deepseek.com/v1`. */
  baseUrl: string;
  apiKey?: string;
  /** Extra headers, e.g. OpenRouter's attribution headers. */
  headers?: Record<string, string>;
  capabilityOverrides?: CapabilityOverrides;
  /** Injected for tests and for the record/replay provider. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Generous by default: agent turns are long. */
  timeoutMs?: number;
  maxRetries?: number;
  /** Used only when the endpoint reports no usage. Phase 4 injects a real one. */
  countTokens?: TokenCounter;
}

export class OpenAICompatProvider implements Provider {
  readonly id: string;
  private readonly cfg: Required<
    Pick<OpenAICompatConfig, 'baseUrl' | 'timeoutMs' | 'maxRetries'>
  > &
    OpenAICompatConfig;
  private readonly doFetch: typeof fetch;
  private readonly countTokens: TokenCounter;

  constructor(config: OpenAICompatConfig) {
    this.id = config.id;
    this.cfg = {
      ...config,
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      timeoutMs: config.timeoutMs ?? 600_000,
      maxRetries: config.maxRetries ?? 3,
    };
    this.doFetch = config.fetchImpl ?? globalThis.fetch;
    this.countTokens = config.countTokens ?? heuristicTokenCount;
  }

  capabilities(model: string): ModelCapabilities {
    return resolveCapabilities(this.id, model, this.cfg.capabilityOverrides ?? {});
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const caps = this.capabilities(req.model);
    if (caps.streaming) return drainStream(this.stream(req));
    return this.completeNonStreaming(req, caps);
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    const caps = this.capabilities(req.model);
    if (!caps.streaming) {
      // Keep one code path for callers: synthesize a stream from one response.
      const res = await this.completeNonStreaming(req, caps);
      yield { type: 'message_start', model: res.model };
      for (const block of res.content) {
        if (block.type === 'text') yield { type: 'text_delta', text: block.text };
        else if (block.type === 'thinking')
          yield { type: 'thinking_delta', text: block.text };
      }
      let i = 0;
      for (const block of res.content) {
        if (block.type !== 'tool_use') continue;
        yield { type: 'tool_use_start', index: i, id: block.id, name: block.name };
        if (block.rawInput)
          yield { type: 'tool_use_delta', index: i, argsDelta: block.rawInput };
        yield { type: 'tool_use_end', index: i, block };
        i++;
      }
      yield { type: 'message_end', response: res };
      return;
    }
    yield* this.streamNative(req, caps);
  }

  // -------------------------------------------------------------------------
  // Streaming
  // -------------------------------------------------------------------------

  private async *streamNative(
    req: ModelRequest,
    caps: ModelCapabilities,
  ): AsyncGenerator<StreamEvent> {
    const usePromptTools = !caps.nativeTools && (req.tools?.length ?? 0) > 0;
    const body = this.buildBody(req, caps, true, usePromptTools);
    const started = Date.now();
    let ttftMs: number | undefined;

    const { response, dispose, timeoutSignal } = await this.request(
      '/chat/completions',
      body,
      req.signal,
    );
    if (!response.body) {
      dispose();
      throw new ProviderError('protocol', 'Streaming response had no body', {
        provider: this.id,
      });
    }
    // The reader watches both the caller's signal and the request deadline, so
    // a timeout mid-stream cancels it cleanly instead of surfacing as an
    // unhandled `TimeoutError`.
    const readSignal = req.signal
      ? AbortSignal.any([req.signal, timeoutSignal])
      : timeoutSignal;

    yield { type: 'message_start', model: req.model };

    const acc = new ToolCallAccumulator();
    const promptParser = usePromptTools ? new PromptToolParser() : undefined;
    let text = '';
    let thinking = '';
    let finishReason: string | undefined;
    let usage: Usage | undefined;
    let sawAnyChunk = false;
    let promptToolIndex = 0;
    const promptToolBlocks: ToolUseBlock[] = [];

    try {
      for await (const msg of parseSSE(response.body, readSignal)) {
        if (msg.data === '[DONE]') break;

        const parsed = parseLooseJSON(msg.data);
        if (!parsed.ok) {
          // A malformed frame is not worth aborting a long turn over; note it
          // and keep reading. A truly broken stream fails the protocol check
          // below.
          continue;
        }
        const chunk = parsed.value as OpenAIStreamChunk;

        // Some gateways deliver errors inside the SSE stream with HTTP 200.
        if (chunk.error) {
          throw mapErrorPayload(chunk.error, this.id, undefined);
        }

        if (chunk.usage) usage = normalizeUsage(chunk.usage);

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        sawAnyChunk = true;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta ?? {};

        // Reasoning channel: DeepSeek uses `reasoning_content`, OpenRouter and
        // a few others use `reasoning`.
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string' && reasoning !== '') {
          thinking += reasoning;
          ttftMs ??= Date.now() - started;
          yield { type: 'thinking_delta', text: reasoning };
        }

        const contentDelta = normalizeContentDelta(delta.content);
        if (contentDelta !== '') {
          ttftMs ??= Date.now() - started;
          if (promptParser) {
            const out = promptParser.push(contentDelta);
            if (out.text !== '') {
              text += out.text;
              yield { type: 'text_delta', text: out.text };
            }
            for (const block of out.calls) {
              const idx = promptToolIndex++;
              promptToolBlocks.push(block);
              yield { type: 'tool_use_start', index: idx, id: block.id, name: block.name };
              if (block.rawInput)
                yield { type: 'tool_use_delta', index: idx, argsDelta: block.rawInput };
              yield { type: 'tool_use_end', index: idx, block };
            }
          } else {
            text += contentDelta;
            yield { type: 'text_delta', text: contentDelta };
          }
        }

        if (delta.tool_calls) {
          ttftMs ??= Date.now() - started;
          for (const ev of acc.push(delta.tool_calls)) yield ev;
        }
      }
    } catch (err) {
      throw normalizeStreamError(err, req.signal, timeoutSignal, this.id, this.cfg.timeoutMs);
    } finally {
      // Stream drained (or failed) — the deadline is no longer needed.
      dispose();
    }

    // `parseSSE` cancels its reader on abort, which ends the loop cleanly rather
    // than throwing — so an abort/timeout would otherwise surface as a silently
    // truncated completion. Catch that here.
    if (req.signal?.aborted || timeoutSignal.aborted) {
      throw normalizeStreamError(
        timeoutSignal.aborted && !req.signal?.aborted
          ? new DOMException('stream deadline', 'TimeoutError')
          : new DOMException('aborted', 'AbortError'),
        req.signal,
        timeoutSignal,
        this.id,
        this.cfg.timeoutMs,
      );
    }

    if (promptParser) {
      const out = promptParser.end();
      if (out.text !== '') {
        text += out.text;
        yield { type: 'text_delta', text: out.text };
      }
      for (const block of out.calls) {
        const idx = promptToolIndex++;
        promptToolBlocks.push(block);
        yield { type: 'tool_use_start', index: idx, id: block.id, name: block.name };
        if (block.rawInput)
          yield { type: 'tool_use_delta', index: idx, argsDelta: block.rawInput };
        yield { type: 'tool_use_end', index: idx, block };
      }
    }

    if (!sawAnyChunk && !usage) {
      throw new ProviderError('protocol', 'Stream contained no completion chunks', {
        provider: this.id,
      });
    }

    const nativeBlocks: ToolUseBlock[] = [];
    for (const { index, block } of acc.finalize()) {
      yield { type: 'tool_use_end', index, block };
      nativeBlocks.push(block);
    }

    const toolBlocks = usePromptTools ? promptToolBlocks : nativeBlocks;
    const content = assembleContent(text, thinking, toolBlocks);
    const response_: ModelResponse = {
      model: req.model,
      content,
      stopReason: normalizeStopReason(finishReason, toolBlocks.length > 0),
      usage: usage ?? this.estimateUsage(req, text + thinking),
      latencyMs: Date.now() - started,
    };
    if (ttftMs !== undefined) response_.ttftMs = ttftMs;
    response_.usage.costUSD = estimateCostUSD(response_.usage, caps.pricing);

    yield { type: 'message_end', response: response_ };
  }

  // -------------------------------------------------------------------------
  // Non-streaming
  // -------------------------------------------------------------------------

  private async completeNonStreaming(
    req: ModelRequest,
    caps: ModelCapabilities,
  ): Promise<ModelResponse> {
    const usePromptTools = !caps.nativeTools && (req.tools?.length ?? 0) > 0;
    const body = this.buildBody(req, caps, false, usePromptTools);
    const started = Date.now();
    const { response, dispose, timeoutSignal } = await this.request(
      '/chat/completions',
      body,
      req.signal,
    );
    let json: OpenAICompletion;
    try {
      json = (await abortable(response.json(), timeoutSignal)) as OpenAICompletion;
    } catch (err) {
      throw normalizeStreamError(err, req.signal, timeoutSignal, this.id, this.cfg.timeoutMs);
    } finally {
      dispose();
    }

    if (json.error) throw mapErrorPayload(json.error, this.id, response.status);

    const choice = json.choices?.[0];
    const rawText = normalizeContentDelta(choice?.message?.content);
    const thinking =
      choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? '';

    let text = rawText;
    let toolBlocks: ToolUseBlock[] = [];

    if (usePromptTools) {
      const parser = new PromptToolParser();
      const a = parser.push(rawText);
      const b = parser.end();
      text = a.text + b.text;
      toolBlocks = [...a.calls, ...b.calls];
    } else {
      toolBlocks = (choice?.message?.tool_calls ?? []).map((tc, i) =>
        buildToolUseBlock(tc.id ?? `call_${i}`, tc.function?.name ?? '', tc.function?.arguments ?? ''),
      );
    }

    const usage = json.usage
      ? normalizeUsage(json.usage)
      : this.estimateUsage(req, text + thinking);
    usage.costUSD = estimateCostUSD(usage, caps.pricing);

    return {
      model: json.model ?? req.model,
      content: assembleContent(text, thinking, toolBlocks),
      stopReason: normalizeStopReason(choice?.finish_reason, toolBlocks.length > 0),
      usage,
      latencyMs: Date.now() - started,
    };
  }

  // -------------------------------------------------------------------------
  // Request building
  // -------------------------------------------------------------------------

  private buildBody(
    req: ModelRequest,
    caps: ModelCapabilities,
    stream: boolean,
    usePromptTools: boolean,
  ): Record<string, unknown> {
    const system = usePromptTools
      ? appendSystemSegment(req.system, {
          id: 'tool-protocol',
          text: renderToolPrompt(req.tools ?? []),
        })
      : req.system;

    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAIMessages(system, req.messages, caps),
      stream,
    };

    if (req.maxOutputTokens !== undefined) {
      // Reasoning models on OpenAI renamed this parameter; everyone else kept
      // the old name, and several endpoints reject the new one outright.
      const key = caps.developerRole ? 'max_completion_tokens' : 'max_tokens';
      body[key] = Math.min(req.maxOutputTokens, caps.maxOutputTokens);
    }
    if (req.temperature !== undefined && !caps.fixedTemperature) {
      body['temperature'] = req.temperature;
    }
    if (req.topP !== undefined && !caps.fixedTemperature) body['top_p'] = req.topP;
    if (req.stopSequences?.length) body['stop'] = req.stopSequences;

    if (!usePromptTools && req.tools?.length) {
      body['tools'] = req.tools.map(toOpenAITool);
      if (req.toolChoice) body['tool_choice'] = toOpenAIToolChoice(req.toolChoice);
      // Only send this where it is understood: endpoints that do not know the
      // field reject the whole request rather than ignoring it.
      if (!caps.parallelToolCalls) body['parallel_tool_calls'] = false;
    }

    if (stream && caps.streamUsage) {
      body['stream_options'] = { include_usage: true };
    }

    return { ...body, ...(req.extraBody ?? {}) };
  }

  private async request(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<{ response: Response; dispose: () => void; timeoutSignal: AbortSignal }> {
    const url = `${this.cfg.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream, application/json',
      ...(this.cfg.headers ?? {}),
    };
    if (this.cfg.apiKey) headers['authorization'] = `Bearer ${this.cfg.apiKey}`;

    let lastError: ProviderError | undefined;

    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      // A controlled deadline — NOT `AbortSignal.timeout()`, whose timer would
      // outlive this attempt and, minutes later, fire an uncatchable
      // `TimeoutError` on a signal nobody is listening to (an unhandled
      // rejection that takes the process down). `dispose()` clears it the
      // moment we have a response or an error.
      const dl = deadline(this.cfg.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, dl.signal]) : dl.signal;

      let res: Response;
      try {
        res = await this.doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: combined,
        });
      } catch (err) {
        dl.dispose();
        if (signal?.aborted) {
          throw new ProviderError('aborted', 'Request aborted', {
            provider: this.id,
            retryable: false,
            cause: err,
          });
        }
        // The deadline firing looks like an aborted fetch; classify it as a
        // retryable network timeout, not a hard abort.
        const timedOut = isTimeoutError(err) || dl.signal.aborted;
        lastError = new ProviderError(
          'network',
          timedOut
            ? `Request to ${this.id} timed out after ${this.cfg.timeoutMs}ms`
            : `Could not reach ${this.id} at ${this.cfg.baseUrl}: ${errText(err)}`,
          { provider: this.id, retryable: true, cause: err },
        );
        if (attempt < this.cfg.maxRetries) {
          await sleep(backoffMs(attempt), signal);
          continue;
        }
        throw lastError;
      }

      if (res.ok) {
        // Headers are in. The body (JSON parse or SSE read) is the caller's to
        // consume; hand back the deadline so it stays armed until that is done.
        return { response: res, dispose: dl.dispose, timeoutSignal: dl.signal };
      }

      dl.dispose();
      const detail = await safeReadText(res);
      const error = mapHttpError(res.status, detail, this.id);
      if (!error.retryable || attempt === this.cfg.maxRetries) throw error;
      lastError = error;
      await sleep(retryAfterMs(res.headers) ?? backoffMs(attempt), signal);
    }

    throw lastError ?? new ProviderError('unknown', 'Request failed', { provider: this.id });
  }

  private estimateUsage(req: ModelRequest, output: string): Usage {
    return {
      ...emptyUsage(),
      inputTokens: this.countTokens(flattenRequestText(req)),
      outputTokens: this.countTokens(output),
      estimated: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Streaming tool-call assembly
// ---------------------------------------------------------------------------

interface Slot {
  id: string;
  name: string;
  args: string;
  /** Whether `tool_use_start` has been emitted (needs a name to be useful). */
  started: boolean;
  ended: boolean;
}

/**
 * Reassembles `tool_calls` deltas.
 *
 * The failure modes this exists to absorb, all observed in the wild:
 *   - `index` present and stable (OpenAI) — the easy case.
 *   - `index` absent entirely; deltas belong to the most recently opened call.
 *   - `id` only on the first delta, or never sent at all.
 *   - `function.name` split across chunks, or repeated identically in every
 *     chunk (in which case appending would produce `readreadread`).
 *   - The whole call delivered complete in a single chunk.
 */
export class ToolCallAccumulator {
  private readonly slots = new Map<number, Slot>();
  private nextIndex = 0;
  private lastIndex = -1;

  push(deltas: readonly OpenAIToolCallDelta[]): StreamEvent[] {
    const events: StreamEvent[] = [];

    for (const delta of deltas) {
      const index = this.resolveIndex(delta);
      let slot = this.slots.get(index);
      if (!slot) {
        slot = { id: delta.id ?? `call_${index}`, name: '', args: '', started: false, ended: false };
        this.slots.set(index, slot);
      } else if (delta.id && slot.id.startsWith('call_') && delta.id !== slot.id) {
        slot.id = delta.id;
      }
      this.lastIndex = index;

      const name = delta.function?.name;
      if (name) {
        // Repeated-in-every-chunk vs genuinely-split-across-chunks.
        if (slot.name === '') slot.name = name;
        else if (slot.name !== name && !slot.name.endsWith(name)) slot.name += name;
      }

      if (!slot.started && slot.name !== '') {
        slot.started = true;
        events.push({ type: 'tool_use_start', index, id: slot.id, name: slot.name });
      }

      const args = delta.function?.arguments;
      if (typeof args === 'string' && args !== '') {
        slot.args += args;
        if (slot.started) events.push({ type: 'tool_use_delta', index, argsDelta: args });
      }
    }

    return events;
  }

  /** Close every open slot. Emitted in index order so results are deterministic. */
  finalize(): Array<{ index: number; block: ToolUseBlock }> {
    const out: Array<{ index: number; block: ToolUseBlock }> = [];
    for (const index of [...this.slots.keys()].sort((a, b) => a - b)) {
      const slot = this.slots.get(index);
      if (!slot || slot.ended) continue;
      slot.ended = true;
      out.push({ index, block: buildToolUseBlock(slot.id, slot.name, slot.args) });
    }
    return out;
  }

  private resolveIndex(delta: OpenAIToolCallDelta): number {
    if (typeof delta.index === 'number') {
      this.nextIndex = Math.max(this.nextIndex, delta.index + 1);
      return delta.index;
    }
    // No index. A delta carrying an id we have already seen continues that call;
    // a delta carrying a new id starts one; a bare fragment continues the last.
    if (delta.id) {
      for (const [i, slot] of this.slots) if (slot.id === delta.id) return i;
      return this.nextIndex++;
    }
    if (delta.function?.name && this.lastIndex !== -1) {
      const last = this.slots.get(this.lastIndex);
      // A fresh name on an already-named slot means a new call, not a rename.
      if (last && last.name !== '' && last.name !== delta.function.name) {
        return this.nextIndex++;
      }
    }
    return this.lastIndex === -1 ? this.nextIndex++ : this.lastIndex;
  }
}

function buildToolUseBlock(id: string, name: string, args: string): ToolUseBlock {
  const raw = args.trim();
  const block: ToolUseBlock = { type: 'tool_use', id, name, input: {}, rawInput: raw };
  if (raw === '') return block;

  const parsed = parseLooseJSON(raw);
  if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null) {
    block.input = parsed.value;
  } else {
    block.parseError = parsed.error ?? 'tool arguments were not a JSON object';
  }
  return block;
}

// ---------------------------------------------------------------------------
// Translation: internal shape -> OpenAI shape
// ---------------------------------------------------------------------------

export function toOpenAIMessages(
  system: readonly SystemSegment[] | undefined,
  messages: readonly Message[],
  caps: ModelCapabilities,
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  const systemText = (system ?? []).map((s) => s.text).join('\n\n');
  if (systemText !== '') {
    out.push({ role: caps.developerRole ? 'developer' : 'system', content: systemText });
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      // Tool results must land immediately after the assistant turn that asked
      // for them, and before any new user text, or the endpoint 400s.
      for (const block of msg.content) {
        if (block.type !== 'tool_result') continue;
        out.push({
          role: 'tool',
          tool_call_id: block.toolUseId,
          content: block.content === '' ? '(no output)' : block.content,
        });
      }
      const text = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n');
      if (text !== '') out.push({ role: 'user', content: text });
      continue;
    }

    const text = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    const toolCalls = msg.content.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use',
    );

    // Thinking blocks are deliberately dropped on the way out. DeepSeek rejects
    // replayed `reasoning_content`, and no OpenAI-compatible endpoint accepts a
    // reasoning field on an input message. We keep them internally for display
    // and telemetry only.
    if (text === '' && toolCalls.length === 0) continue;

    const assistant: OpenAIMessage = {
      role: 'assistant',
      content: text === '' ? null : text,
    };
    if (toolCalls.length > 0) {
      assistant.tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: tc.rawInput ?? JSON.stringify(tc.input ?? {}),
        },
      }));
    }
    out.push(assistant);
  }

  return out;
}

function toOpenAITool(tool: ToolDefinition): unknown {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function toOpenAIToolChoice(choice: NonNullable<ModelRequest['toolChoice']>): unknown {
  if (typeof choice === 'string') return choice;
  return { type: 'function', function: { name: choice.name } };
}

function appendSystemSegment(
  system: readonly SystemSegment[] | undefined,
  segment: SystemSegment,
): SystemSegment[] {
  return [...(system ?? []), segment];
}

function assembleContent(
  text: string,
  thinking: string,
  toolBlocks: readonly ToolUseBlock[],
): AssistantBlock[] {
  const content: AssistantBlock[] = [];
  if (thinking !== '') content.push({ type: 'thinking', text: thinking });
  if (text !== '') content.push({ type: 'text', text });
  content.push(...toolBlocks);
  return content;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export function normalizeStopReason(
  finishReason: string | undefined | null,
  hasToolCalls: boolean,
): StopReason {
  switch (finishReason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
    case 'max_tokens':
      return 'max_tokens';
    case 'content_filter':
      return 'content_filter';
    case 'stop':
    case 'stop_sequence':
    case 'eos':
      // Several endpoints report `stop` even when they returned tool calls.
      // Trusting the field over the payload would strand the loop.
      return hasToolCalls ? 'tool_use' : 'end_turn';
    default:
      return hasToolCalls ? 'tool_use' : 'end_turn';
  }
}

export function normalizeUsage(raw: OpenAIUsage): Usage {
  const cached =
    raw.prompt_tokens_details?.cached_tokens ??
    raw.prompt_cache_hit_tokens ??
    raw.cache_read_input_tokens ??
    0;
  const usage: Usage = {
    inputTokens: raw.prompt_tokens ?? raw.input_tokens ?? 0,
    outputTokens: raw.completion_tokens ?? raw.output_tokens ?? 0,
    cachedInputTokens: cached,
  };
  const reasoning = raw.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoning === 'number' && reasoning > 0) usage.reasoningTokens = reasoning;
  return usage;
}

/**
 * `content` is a string on every well-behaved endpoint, but some return the
 * multimodal parts array even for plain text, and a few return `null`.
 */
function normalizeContentDelta(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof (part as { text?: unknown })?.text === 'string'
            ? (part as { text: string }).text
            : '',
      )
      .join('');
  }
  return '';
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function mapHttpError(status: number, detail: string, provider: string): ProviderError {
  const parsed = parseLooseJSON(detail);
  const payload =
    parsed.ok && typeof parsed.value === 'object' && parsed.value !== null
      ? ((parsed.value as { error?: unknown }).error ?? parsed.value)
      : undefined;
  const message = extractMessage(payload) ?? (detail.slice(0, 400) || `HTTP ${status}`);

  if (status === 401 || status === 403) {
    return new ProviderError('auth', `${provider}: ${message}`, {
      status,
      provider,
      retryable: false,
      detail: redact(detail),
    });
  }
  if (status === 404) {
    return new ProviderError(
      'not_found',
      `${provider}: ${message} (check the model id and base URL)`,
      { status, provider, retryable: false, detail: redact(detail) },
    );
  }
  if (status === 429) {
    return new ProviderError('rate_limit', `${provider}: ${message}`, {
      status,
      provider,
      detail: redact(detail),
    });
  }
  if (status === 400 || status === 413 || status === 422) {
    const kind = /context|too long|maximum.*token|token.*limit|reduce the length/i.test(
      message,
    )
      ? 'context_length'
      : 'bad_request';
    return new ProviderError(kind, `${provider}: ${message}`, {
      status,
      provider,
      retryable: false,
      detail: redact(detail),
    });
  }
  if (status >= 500) {
    return new ProviderError('server', `${provider}: ${message}`, {
      status,
      provider,
      detail: redact(detail),
    });
  }
  return new ProviderError('unknown', `${provider}: ${message}`, {
    status,
    provider,
    retryable: false,
    detail: redact(detail),
  });
}

function mapErrorPayload(
  payload: unknown,
  provider: string,
  status: number | undefined,
): ProviderError {
  return mapHttpError(status ?? 500, JSON.stringify({ error: payload }), provider);
}

function extractMessage(payload: unknown): string | undefined {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return undefined;
  const obj = payload as Record<string, unknown>;
  for (const key of ['message', 'msg', 'detail', 'error_msg']) {
    const v = obj[key];
    if (typeof v === 'string' && v !== '') return v;
    if (v && typeof v === 'object') {
      const nested = extractMessage(v);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** Strip anything that looks like a credential before it reaches a log. */
function redact(text: string): string {
  return text
    .replace(/(sk-|xai-|gsk_)[A-Za-z0-9_-]{8,}/g, '$1***')
    .replace(/("?(api[_-]?key|authorization|token)"?\s*[:=]\s*")([^"]+)(")/gi, '$1***$4')
    .slice(0, 2_000);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function backoffMs(attempt: number): number {
  const base = Math.min(1_000 * 2 ** attempt, 20_000);
  return base + Math.random() * 250;
}

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 60_000));
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError('aborted', 'Aborted while backing off'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError('aborted', 'Aborted while backing off'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A timeout signal whose timer is cleared by `dispose()`.
 *
 * Deliberately not `AbortSignal.timeout()`: that schedules a timer with no
 * handle to cancel it, so a request that finishes early leaves a timer that
 * fires minutes later and aborts a signal nobody listens to — Node reports the
 * resulting `TimeoutError` as an unhandled rejection and the process exits.
 */
function deadline(ms: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Timed out after ${ms}ms`, 'TimeoutError'));
  }, ms);
  // Don't keep the event loop alive just for the deadline.
  (timer as { unref?: () => void }).unref?.();
  let done = false;
  return {
    signal: controller.signal,
    dispose: () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
    },
  };
}

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error && (err.name === 'TimeoutError' || err.name === 'HeadersTimeoutError')
  );
}

/** Reject when `signal` aborts; otherwise settle with `p`. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Turn whatever escapes a streaming/body read into a `ProviderError` so a slow
 * or dropped response fails one turn (retryably) instead of crashing the run.
 */
function normalizeStreamError(
  err: unknown,
  externalSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  id: string,
  timeoutMs: number,
): ProviderError {
  if (err instanceof ProviderError) return err;
  if (externalSignal?.aborted) {
    return new ProviderError('aborted', 'Request aborted', {
      provider: id,
      retryable: false,
      cause: err,
    });
  }
  if (isTimeoutError(err) || timeoutSignal.aborted) {
    return new ProviderError(
      'network',
      `Streaming response from ${id} timed out after ${timeoutMs}ms`,
      { provider: id, retryable: true, cause: err },
    );
  }
  const name = err instanceof Error ? err.name : '';
  if (name === 'AbortError') {
    return new ProviderError('network', `Connection to ${id} dropped mid-stream`, {
      provider: id,
      retryable: true,
      cause: err,
    });
  }
  return new ProviderError('network', `Stream from ${id} failed: ${errText(err)}`, {
    provider: id,
    retryable: true,
    cause: err,
  });
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Moved to `../context/tokenizer.ts` so the loop can share it; re-exported here
// because that is where callers (and tests) have always imported it from.
export { heuristicTokenCount } from '../context/tokenizer.js';

// ---------------------------------------------------------------------------
// Wire shapes (only the fields we read)
// ---------------------------------------------------------------------------

export interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIDelta {
  role?: string;
  content?: unknown;
  reasoning_content?: string;
  reasoning?: string;
  tool_calls?: OpenAIToolCallDelta[];
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_cache_hit_tokens?: number;
  cache_read_input_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface OpenAIStreamChunk {
  model?: string;
  error?: unknown;
  usage?: OpenAIUsage;
  choices?: Array<{ index?: number; delta?: OpenAIDelta; finish_reason?: string | null }>;
}

interface OpenAICompletion {
  model?: string;
  error?: unknown;
  usage?: OpenAIUsage;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: unknown;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
}

export interface OpenAIMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}
