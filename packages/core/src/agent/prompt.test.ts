import { describe, expect, it } from 'vitest';

import { buildAgentSystemPrompt } from './prompt.js';

describe('buildAgentSystemPrompt', () => {
  it('orders segments identity, conventions, then environment', () => {
    const segments = buildAgentSystemPrompt({ cwd: '/workspace', platform: 'linux' });
    expect(segments.map((s) => s.id)).toEqual(['identity', 'conventions', 'environment']);
  });

  it('states the read-before-edit invariant enforced by the edit tool', () => {
    const [, conventions] = buildAgentSystemPrompt({ cwd: '/workspace', platform: 'linux' });
    expect(conventions?.text).toMatch(/read.*before editing/i);
  });

  it('includes the given cwd and platform in the environment segment', () => {
    const segments = buildAgentSystemPrompt({ cwd: '/workspace/project', platform: 'darwin' });
    const environment = segments.find((s) => s.id === 'environment');
    expect(environment?.text).toContain('/workspace/project');
    expect(environment?.text).toContain('darwin');
  });

  it('defaults platform to process.platform when omitted', () => {
    const segments = buildAgentSystemPrompt({ cwd: '/workspace' });
    const environment = segments.find((s) => s.id === 'environment');
    expect(environment?.text).toContain(process.platform);
  });

  it('marks conventions as a cache breakpoint ahead of the per-run environment segment', () => {
    const segments = buildAgentSystemPrompt({ cwd: '/workspace', platform: 'linux' });
    const conventions = segments.find((s) => s.id === 'conventions');
    expect(conventions?.cacheBreakpoint).toBe(true);
  });
});
