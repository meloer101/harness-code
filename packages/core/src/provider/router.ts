/**
 * Model routing, LiteLLM-style.
 *
 * A model is named `provider/model`, split on the *first* slash so aggregator
 * ids survive intact (`openrouter/anthropic/claude-sonnet-4`). The registry
 * turns that string into a live provider with a base URL, credentials and a
 * capability profile, and it is the only place that reads API keys.
 */

import { OpenAICompatProvider } from './openai-compat.js';
import type { OpenAICompatConfig, TokenCounter } from './openai-compat.js';
import type { CapabilityOverrides, ModelCapabilities } from './capabilities.js';
import { resolveCapabilities } from './capabilities.js';
import { ProviderError } from './types.js';
import type { Provider } from './types.js';

export interface ProviderConfig {
  /** Human-readable name for error messages. */
  label: string;
  baseUrl: string;
  /** Environment variables checked in order for the API key. */
  apiKeyEnv?: string[];
  /** Literal key from settings. Takes precedence over the environment. */
  apiKey?: string;
  headers?: Record<string, string>;
  /** Local runtimes need no credentials; refusing to start without one is wrong. */
  requiresKey?: boolean;
  timeoutMs?: number;
}

/**
 * Endpoints known to speak OpenAI Chat Completions. Adding one is a data change
 * — that is the whole point of routing through a single adapter.
 */
export const BUILTIN_PROVIDERS: Record<string, ProviderConfig> = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: ['OPENAI_API_KEY'],
    requiresKey: true,
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: ['DEEPSEEK_API_KEY'],
    requiresKey: true,
  },
  moonshot: {
    label: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyEnv: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    requiresKey: true,
  },
  dashscope: {
    label: 'Alibaba DashScope (Qwen)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: ['DASHSCOPE_API_KEY'],
    requiresKey: true,
  },
  zhipu: {
    label: 'Zhipu (GLM)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnv: ['ZHIPU_API_KEY', 'GLM_API_KEY'],
    requiresKey: true,
  },
  siliconflow: {
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKeyEnv: ['SILICONFLOW_API_KEY'],
    requiresKey: true,
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: ['OPENROUTER_API_KEY'],
    requiresKey: true,
    headers: {
      'http-referer': 'https://github.com/harness-code/harness-code',
      'x-title': 'harness-code',
    },
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: ['GROQ_API_KEY'],
    requiresKey: true,
  },
  together: {
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyEnv: ['TOGETHER_API_KEY'],
    requiresKey: true,
  },
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: ['MISTRAL_API_KEY'],
    requiresKey: true,
  },
  xai: {
    label: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnv: ['XAI_API_KEY'],
    requiresKey: true,
  },
  litellm: {
    label: 'LiteLLM proxy',
    baseUrl: 'http://localhost:4000',
    apiKeyEnv: ['LITELLM_API_KEY'],
    requiresKey: false,
  },
  ollama: {
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    requiresKey: false,
  },
  vllm: {
    label: 'vLLM',
    baseUrl: 'http://localhost:8000/v1',
    apiKeyEnv: ['VLLM_API_KEY'],
    requiresKey: false,
  },
  llamacpp: {
    label: 'llama.cpp server',
    baseUrl: 'http://localhost:8080/v1',
    requiresKey: false,
  },
};

export interface ModelRef {
  provider: string;
  model: string;
}

/** `deepseek/deepseek-v4-flash` -> `{ provider, model }`. Split on the first slash. */
export function parseModelRef(ref: string, defaultProvider = 'openai'): ModelRef {
  const trimmed = ref.trim();
  if (trimmed === '') {
    throw new ProviderError('bad_request', 'Model reference was empty');
  }
  const slash = trimmed.indexOf('/');
  if (slash === -1) return { provider: defaultProvider, model: trimmed };

  const provider = trimmed.slice(0, slash);
  const model = trimmed.slice(slash + 1);
  if (model === '') {
    throw new ProviderError(
      'bad_request',
      `Model reference "${ref}" has a provider but no model`,
    );
  }
  return { provider, model };
}

export interface RouterSettings {
  defaultProvider?: string;
  defaultModel?: string;
  /** Adds new providers and overrides fields on built-in ones. */
  providers?: Record<string, Partial<ProviderConfig>>;
  capabilities?: CapabilityOverrides;
}

export interface RouterOptions {
  settings?: RouterSettings;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  countTokens?: TokenCounter;
}

export interface ResolvedModel {
  provider: Provider;
  providerId: string;
  /** Bare model id, as the endpoint expects it. */
  model: string;
  /** Original `provider/model` string, for logs and telemetry. */
  ref: string;
  capabilities: ModelCapabilities;
}

export class ProviderRegistry {
  private readonly settings: RouterSettings;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cache = new Map<string, Provider>();
  private readonly opts: RouterOptions;

  constructor(opts: RouterOptions = {}) {
    this.opts = opts;
    this.settings = opts.settings ?? {};
    this.env = opts.env ?? process.env;
  }

  /** Every provider id that is configured, whether built-in or user-defined. */
  list(): string[] {
    return [
      ...new Set([
        ...Object.keys(BUILTIN_PROVIDERS),
        ...Object.keys(this.settings.providers ?? {}),
      ]),
    ].sort();
  }

  config(providerId: string): ProviderConfig {
    const builtin = BUILTIN_PROVIDERS[providerId];
    const override = this.settings.providers?.[providerId];
    if (!builtin && !override) {
      throw new ProviderError(
        'not_found',
        `Unknown provider "${providerId}". Known providers: ${this.list().join(', ')}. ` +
          `Add a custom one under "providers" in settings.json.`,
      );
    }
    const merged: ProviderConfig = {
      label: providerId,
      baseUrl: '',
      ...(builtin ?? {}),
      ...(override ?? {}),
    };

    // Environment wins over settings for the base URL so a proxy can be pointed
    // at without editing files.
    const envBase = this.env[`HC_${envKey(providerId)}_BASE_URL`];
    if (envBase) merged.baseUrl = envBase;

    if (!merged.baseUrl) {
      throw new ProviderError(
        'bad_request',
        `Provider "${providerId}" has no baseUrl. Set it in settings.json or via ` +
          `HC_${envKey(providerId)}_BASE_URL.`,
      );
    }
    return merged;
  }

  resolve(ref: string): ResolvedModel {
    const { provider: providerId, model } = parseModelRef(
      ref,
      this.settings.defaultProvider ?? 'openai',
    );
    const cfg = this.config(providerId);
    const apiKey = this.apiKeyFor(providerId, cfg);

    if (cfg.requiresKey && !apiKey) {
      const names =
        (cfg.apiKeyEnv ?? []).join(' or ') || `HC_${envKey(providerId)}_API_KEY`;
      throw new ProviderError(
        'auth',
        `${cfg.label} needs an API key. Set ${names} in your environment, or put it ` +
          `under providers.${providerId}.apiKey in settings.json.`,
        { provider: providerId, retryable: false },
      );
    }

    let provider = this.cache.get(providerId);
    if (!provider) {
      const providerConfig: OpenAICompatConfig = {
        id: providerId,
        baseUrl: cfg.baseUrl,
        capabilityOverrides: this.settings.capabilities ?? {},
      };
      if (apiKey) providerConfig.apiKey = apiKey;
      if (cfg.headers) providerConfig.headers = cfg.headers;
      if (cfg.timeoutMs !== undefined) providerConfig.timeoutMs = cfg.timeoutMs;
      if (this.opts.fetchImpl) providerConfig.fetchImpl = this.opts.fetchImpl;
      if (this.opts.countTokens) providerConfig.countTokens = this.opts.countTokens;

      provider = new OpenAICompatProvider(providerConfig);
      this.cache.set(providerId, provider);
    }

    return {
      provider,
      providerId,
      model,
      ref,
      capabilities: resolveCapabilities(
        providerId,
        model,
        this.settings.capabilities ?? {},
      ),
    };
  }

  /** Register an already-constructed provider. Used by tests and replay. */
  register(providerId: string, provider: Provider): void {
    this.cache.set(providerId, provider);
  }

  private apiKeyFor(providerId: string, cfg: ProviderConfig): string | undefined {
    if (cfg.apiKey) return cfg.apiKey;
    const generic = this.env[`HC_${envKey(providerId)}_API_KEY`];
    if (generic) return generic;
    for (const name of cfg.apiKeyEnv ?? []) {
      const value = this.env[name];
      if (value) return value;
    }
    return undefined;
  }
}

function envKey(providerId: string): string {
  return providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}
