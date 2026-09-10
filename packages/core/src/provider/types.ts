/**
 * The normalized wire model.
 *
 * Everything inside the harness speaks *this* shape. Providers are the only
 * place allowed to know what OpenAI, Anthropic or a random self-hosted vLLM
 * actually want on the wire. The moment provider-specific shapes leak into the
 * agent loop, adding the next endpoint stops being a contained change.
 */

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}

/** Reasoning / chain-of-thought surfaced by the model (DeepSeek R1, o-series, ...). */
export interface ThinkingBlock {
  type: 'thinking';
  text: string;
  /** Opaque provider token needed to replay the thinking block on later turns. */
  signature?: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  /**
   * Raw argument text as emitted by the model. Kept because some endpoints emit
   * JSON we can only partially repair, and the loop wants to show the user what
   * was actually said rather than our reconstruction of it.
   */
  rawInput?: string;
  /** Set when `rawInput` could not be parsed into `input` cleanly. */
  parseError?: string;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export type AssistantBlock = TextBlock | ThinkingBlock | ToolUseBlock;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Only `user` and `assistant` exist internally. Tool results ride inside a
 * `user` message as `tool_result` blocks (Anthropic's shape) because it keeps
 * one tool call and its result adjacent and un-splittable; the OpenAI provider
 * fans them back out into `role: "tool"` messages on the way out.
 */
export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

/**
 * A system prompt in ordered segments. Segment boundaries are where explicit
 * prompt-cache breakpoints can go, and the order is deliberately stable so
 * implicit prefix caches keep hitting across turns.
 */
export interface SystemSegment {
  /** Stable identity, e.g. `identity`, `skills`, `project-memory`, `env`. */
  id: string;
  text: string;
  /** Request an explicit cache breakpoint after this segment, where supported. */
  cacheBreakpoint?: boolean;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface JSONSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

export interface ModelRequest {
  /** Bare model id as the endpoint expects it (routing already stripped). */
  model: string;
  system?: SystemSegment[];
  messages: Message[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  signal?: AbortSignal;
  /** Escape hatch for endpoint-specific knobs; merged into the request body. */
  extraBody?: Record<string, unknown>;
}

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'content_filter'
  | 'aborted'
  | 'error';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Portion of `inputTokens` served from a prompt cache. */
  cachedInputTokens: number;
  reasoningTokens?: number;
  costUSD?: number;
  /** True when the numbers are our own estimate, not reported by the endpoint. */
  estimated?: boolean;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  const out: Usage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  };
  const reasoning = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);
  if (reasoning > 0) out.reasoningTokens = reasoning;
  const cost = (a.costUSD ?? 0) + (b.costUSD ?? 0);
  if (cost > 0) out.costUSD = cost;
  if (a.estimated || b.estimated) out.estimated = true;
  return out;
}

export interface ModelResponse {
  model: string;
  content: AssistantBlock[];
  stopReason: StopReason;
  usage: Usage;
  /** Milliseconds from request start to the final event. */
  latencyMs?: number;
  /** Milliseconds to the first content token; the number users actually feel. */
  ttftMs?: number;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export type StreamEvent =
  | { type: 'message_start'; model: string }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; index: number; id: string; name: string }
  | { type: 'tool_use_delta'; index: number; argsDelta: string }
  | { type: 'tool_use_end'; index: number; block: ToolUseBlock }
  | { type: 'message_end'; response: ModelResponse };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ProviderErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'context_length'
  | 'bad_request'
  | 'not_found'
  | 'network'
  | 'server'
  | 'aborted'
  | 'protocol'
  | 'unknown';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly provider: string | undefined;
  /** Truncated response body, for diagnostics. Never contains credentials. */
  readonly detail: string | undefined;
  /** Server-suggested wait before retrying, from `Retry-After` / similar. */
  readonly retryAfterMs: number | undefined;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    opts: {
      status?: number;
      retryable?: boolean;
      provider?: string;
      detail?: string;
      retryAfterMs?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = opts.status;
    this.retryable = opts.retryable ?? defaultRetryable(kind);
    this.provider = opts.provider;
    this.detail = opts.detail;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

function defaultRetryable(kind: ProviderErrorKind): boolean {
  return kind === 'rate_limit' || kind === 'network' || kind === 'server';
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface Provider {
  /** Routing id, e.g. `deepseek`, `ollama`, `openrouter`. */
  readonly id: string;
  stream(req: ModelRequest): AsyncIterable<StreamEvent>;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

// ---------------------------------------------------------------------------
// Small helpers used across providers and the agent loop
// ---------------------------------------------------------------------------

export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export function toolUsesOf(blocks: readonly ContentBlock[]): ToolUseBlock[] {
  return blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

export function userText(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

export function assistantText(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

export function systemText(segments: readonly SystemSegment[] | undefined): string {
  if (!segments || segments.length === 0) return '';
  return segments.map((s) => s.text).join('\n\n');
}

/** Drain a stream into a response. The shared fallback for `complete()`. */
export async function drainStream(
  events: AsyncIterable<StreamEvent>,
): Promise<ModelResponse> {
  let last: ModelResponse | undefined;
  for await (const ev of events) {
    if (ev.type === 'message_end') last = ev.response;
  }
  if (!last) {
    throw new ProviderError('protocol', 'Stream ended without a message_end event');
  }
  return last;
}
