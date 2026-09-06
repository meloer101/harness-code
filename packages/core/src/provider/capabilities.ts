/**
 * Per-model capability table.
 *
 * "OpenAI-compatible" is a spectrum, not a contract. Endpoints disagree about
 * parallel tool calls, whether `stream_options.include_usage` exists, whether
 * tool calling works at all, and how big the window really is. Rather than
 * discovering that at runtime inside the agent loop, we declare it here and let
 * every other layer branch on facts instead of vibes.
 */

export type PromptCacheMode = 'none' | 'implicit' | 'explicit';

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok?: number;
}

export interface ModelCapabilities {
  /** Endpoint implements OpenAI `tools` / `tool_calls`. When false we fall back
   *  to prompt-encoded tool calling (see `prompt-tools.ts`). */
  nativeTools: boolean;
  /** More than one tool call may come back in a single assistant turn. */
  parallelToolCalls: boolean;
  streaming: boolean;
  /** Endpoint honours `stream_options: { include_usage: true }`. */
  streamUsage: boolean;
  jsonMode: boolean;
  promptCache: PromptCacheMode;
  /** Model emits a separate reasoning channel we should surface as `thinking`. */
  reasoning: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  /** Endpoint rejects `temperature` (some reasoning models do). */
  fixedTemperature?: boolean;
  /** Use `developer` instead of `system` for the system message. */
  developerRole?: boolean;
  pricing?: Pricing;
}

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  nativeTools: true,
  parallelToolCalls: true,
  streaming: true,
  streamUsage: true,
  jsonMode: false,
  promptCache: 'none',
  reasoning: false,
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
};

interface CapabilityRule {
  /** Provider id, or `*` for any. */
  provider: string;
  /** Matched against the bare model id, case-insensitively. */
  match: RegExp;
  caps: Partial<ModelCapabilities>;
}

/**
 * Ordered most-specific-first; the first match per provider wins, then the
 * provider default, then `DEFAULT_CAPABILITIES`.
 */
const RULES: CapabilityRule[] = [
  // --- DeepSeek -----------------------------------------------------------
  {
    provider: 'deepseek',
    match: /^deepseek-(reasoner|r1)/i,
    caps: {
      reasoning: true,
      // The reasoner rejects temperature/top_p and does not do parallel calls.
      fixedTemperature: true,
      parallelToolCalls: false,
      contextWindow: 128_000,
      maxOutputTokens: 64_000,
      promptCache: 'implicit',
      pricing: { inputPerMTok: 0.55, outputPerMTok: 2.19, cachedInputPerMTok: 0.14 },
    },
  },
  {
    provider: 'deepseek',
    match: /^deepseek-chat/i,
    caps: {
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      promptCache: 'implicit',
      jsonMode: true,
      pricing: { inputPerMTok: 0.27, outputPerMTok: 1.1, cachedInputPerMTok: 0.07 },
    },
  },

  // --- Moonshot / Kimi ----------------------------------------------------
  {
    provider: 'moonshot',
    match: /^kimi-k2/i,
    caps: {
      contextWindow: 256_000,
      maxOutputTokens: 16_384,
      promptCache: 'implicit',
      pricing: { inputPerMTok: 0.6, outputPerMTok: 2.5, cachedInputPerMTok: 0.15 },
    },
  },
  {
    provider: 'moonshot',
    match: /^moonshot-v1-128k/i,
    caps: { contextWindow: 128_000, maxOutputTokens: 8_192 },
  },

  // --- OpenAI -------------------------------------------------------------
  {
    provider: 'openai',
    match: /^(o[1-9]|gpt-5)/i,
    caps: {
      reasoning: true,
      fixedTemperature: true,
      developerRole: true,
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      promptCache: 'implicit',
      jsonMode: true,
    },
  },
  {
    provider: 'openai',
    match: /^gpt-4o/i,
    caps: {
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      promptCache: 'implicit',
      jsonMode: true,
      pricing: { inputPerMTok: 2.5, outputPerMTok: 10, cachedInputPerMTok: 1.25 },
    },
  },

  // --- Qwen via DashScope compatible mode ---------------------------------
  {
    provider: 'dashscope',
    match: /^qwen3-coder/i,
    caps: { contextWindow: 262_144, maxOutputTokens: 65_536, promptCache: 'implicit' },
  },
  {
    provider: 'dashscope',
    match: /^qwen/i,
    caps: { contextWindow: 131_072, maxOutputTokens: 8_192 },
  },

  // --- Zhipu --------------------------------------------------------------
  {
    provider: 'zhipu',
    match: /^glm-4/i,
    caps: { contextWindow: 128_000, maxOutputTokens: 16_384 },
  },

  // --- Local runtimes -----------------------------------------------------
  {
    provider: 'ollama',
    match: /qwen|llama|mistral|devstral|codestral|granite|gemma/i,
    caps: {
      // Ollama's OpenAI shim supports tools, but small models are unreliable at
      // them and it does not report usage on streamed responses.
      streamUsage: false,
      parallelToolCalls: false,
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    },
  },
  {
    provider: 'ollama',
    match: /.*/,
    caps: {
      streamUsage: false,
      parallelToolCalls: false,
      contextWindow: 8_192,
      maxOutputTokens: 2_048,
      pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    },
  },
  {
    provider: 'vllm',
    match: /.*/,
    caps: { streamUsage: false, contextWindow: 32_768, maxOutputTokens: 4_096 },
  },
  {
    provider: 'llamacpp',
    match: /.*/,
    caps: {
      nativeTools: false,
      streamUsage: false,
      parallelToolCalls: false,
      contextWindow: 8_192,
      maxOutputTokens: 2_048,
      pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    },
  },

  // --- Aggregators --------------------------------------------------------
  {
    provider: 'openrouter',
    match: /^anthropic\//i,
    caps: { contextWindow: 200_000, maxOutputTokens: 32_000, promptCache: 'explicit' },
  },
  { provider: 'openrouter', match: /.*/, caps: { contextWindow: 128_000 } },
];

/** Provider-level defaults applied when no rule matches. */
const PROVIDER_DEFAULTS: Record<string, Partial<ModelCapabilities>> = {
  deepseek: { promptCache: 'implicit' },
  moonshot: { promptCache: 'implicit' },
  openai: { promptCache: 'implicit', jsonMode: true },
  ollama: { streamUsage: false, parallelToolCalls: false },
  vllm: { streamUsage: false },
  llamacpp: { nativeTools: false, streamUsage: false },
};

/** User overrides, keyed as `provider/model`, `provider/*`, or `*`. */
export type CapabilityOverrides = Record<string, Partial<ModelCapabilities>>;

export function resolveCapabilities(
  provider: string,
  model: string,
  overrides: CapabilityOverrides = {},
): ModelCapabilities {
  const rule = RULES.find((r) => r.provider === provider && r.match.test(model));
  const merged: ModelCapabilities = {
    ...DEFAULT_CAPABILITIES,
    ...(PROVIDER_DEFAULTS[provider] ?? {}),
    ...(rule?.caps ?? {}),
    ...(overrides['*'] ?? {}),
    ...(overrides[`${provider}/*`] ?? {}),
    ...(overrides[`${provider}/${model}`] ?? {}),
  };
  return merged;
}

export function estimateCostUSD(
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
  pricing: Pricing | undefined,
): number | undefined {
  if (!pricing) return undefined;
  const fresh = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cachedRate = pricing.cachedInputPerMTok ?? pricing.inputPerMTok;
  return (
    (fresh * pricing.inputPerMTok +
      usage.cachedInputTokens * cachedRate +
      usage.outputTokens * pricing.outputPerMTok) /
    1_000_000
  );
}
