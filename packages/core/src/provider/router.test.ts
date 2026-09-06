import { describe, expect, it } from 'vitest';

import { BUILTIN_PROVIDERS, ProviderRegistry, parseModelRef } from './router.js';
import { resolveCapabilities, estimateCostUSD } from './capabilities.js';
import { ProviderError } from './types.js';

describe('parseModelRef', () => {
  it('splits provider from model', () => {
    expect(parseModelRef('deepseek/deepseek-chat')).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
    });
  });

  it('splits on the first slash so aggregator ids survive', () => {
    expect(parseModelRef('openrouter/anthropic/claude-sonnet-4')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
    });
  });

  it('keeps tags that contain a colon', () => {
    expect(parseModelRef('ollama/qwen2.5-coder:7b')).toEqual({
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
    });
  });

  it('falls back to the default provider when none is given', () => {
    expect(parseModelRef('gpt-4o', 'openai')).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('rejects empty and truncated references', () => {
    expect(() => parseModelRef('')).toThrow(ProviderError);
    expect(() => parseModelRef('deepseek/')).toThrow(/no model/);
  });
});

describe('ProviderRegistry', () => {
  it('resolves a built-in provider using its documented env var', () => {
    const reg = new ProviderRegistry({ env: { DEEPSEEK_API_KEY: 'sk-x' } });
    const resolved = reg.resolve('deepseek/deepseek-v4-flash');

    expect(resolved.providerId).toBe('deepseek');
    expect(resolved.model).toBe('deepseek-v4-flash');
    expect(resolved.capabilities.promptCache).toBe('implicit');
  });

  it('needs no credentials for a local runtime', () => {
    const reg = new ProviderRegistry({ env: {} });
    expect(() => reg.resolve('ollama/qwen2.5-coder:7b')).not.toThrow();
  });

  it('explains what to set when a key is missing', () => {
    const reg = new ProviderRegistry({ env: {} });
    const err = (() => {
      try {
        reg.resolve('deepseek/deepseek-chat');
        return undefined;
      } catch (e) {
        return e as ProviderError;
      }
    })();

    expect(err?.kind).toBe('auth');
    expect(err?.message).toContain('DEEPSEEK_API_KEY');
  });

  it('lets the environment override a base URL without touching settings', () => {
    const reg = new ProviderRegistry({
      env: { HC_OLLAMA_BASE_URL: 'http://gpu-box:11434/v1' },
    });
    expect(reg.config('ollama').baseUrl).toBe('http://gpu-box:11434/v1');
  });

  it('accepts a user-defined provider that is not built in', () => {
    const reg = new ProviderRegistry({
      env: {},
      settings: {
        providers: {
          'my-proxy': { label: 'Internal proxy', baseUrl: 'http://proxy.internal/v1' },
        },
      },
    });

    expect(reg.resolve('my-proxy/whatever').providerId).toBe('my-proxy');
    expect(reg.list()).toContain('my-proxy');
  });

  it('names the known providers when asked for an unknown one', () => {
    const reg = new ProviderRegistry({ env: {} });
    expect(() => reg.resolve('nope/x')).toThrow(/Known providers/);
  });

  it('reuses one provider instance per endpoint', () => {
    const reg = new ProviderRegistry({ env: { DEEPSEEK_API_KEY: 'sk-x' } });
    expect(reg.resolve('deepseek/a').provider).toBe(reg.resolve('deepseek/b').provider);
  });

  it('applies capability overrides from settings', () => {
    const reg = new ProviderRegistry({
      env: {},
      settings: { capabilities: { 'ollama/*': { contextWindow: 131_072 } } },
    });
    expect(reg.resolve('ollama/qwen3').capabilities.contextWindow).toBe(131_072);
  });

  it('gives every built-in provider a base URL', () => {
    for (const [id, cfg] of Object.entries(BUILTIN_PROVIDERS)) {
      expect(cfg.baseUrl, id).toMatch(/^https?:\/\//);
      expect(cfg.label, id).toBeTruthy();
    }
  });
});

describe('resolveCapabilities', () => {
  it('marks DeepSeek V4 models as supporting a reasoning channel', () => {
    // Thinking is an effort level (low/high/max) on deepseek-v4-pro/-flash
    // rather than a separate reasoning-only model id, unlike the retired
    // deepseek-reasoner, which rejected temperature and parallel tool calls.
    expect(resolveCapabilities('deepseek', 'deepseek-v4-pro').reasoning).toBe(true);
    expect(resolveCapabilities('deepseek', 'deepseek-v4-flash').reasoning).toBe(true);
  });

  it('knows local runtimes do not report streamed usage', () => {
    expect(resolveCapabilities('ollama', 'qwen2.5-coder:7b').streamUsage).toBe(false);
    expect(resolveCapabilities('llamacpp', 'anything').nativeTools).toBe(false);
  });

  it('layers overrides most-specific last', () => {
    const caps = resolveCapabilities('ollama', 'qwen3', {
      '*': { contextWindow: 1 },
      'ollama/*': { contextWindow: 2 },
      'ollama/qwen3': { contextWindow: 3 },
    });
    expect(caps.contextWindow).toBe(3);
  });

  it('falls back to safe defaults for an unknown endpoint', () => {
    const caps = resolveCapabilities('my-proxy', 'mystery-model');
    expect(caps.nativeTools).toBe(true);
    expect(caps.contextWindow).toBeGreaterThan(0);
  });
});

describe('estimateCostUSD', () => {
  it('bills cached input at the cached rate', () => {
    const pricing = { inputPerMTok: 1, outputPerMTok: 2, cachedInputPerMTok: 0.1 };
    const cost = estimateCostUSD(
      { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 900_000 },
      pricing,
    );
    // 100k fresh at $1/M + 900k cached at $0.10/M
    expect(cost).toBeCloseTo(0.1 + 0.09, 6);
  });

  it('returns undefined when pricing is unknown', () => {
    expect(
      estimateCostUSD({ inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 }, undefined),
    ).toBeUndefined();
  });
});
