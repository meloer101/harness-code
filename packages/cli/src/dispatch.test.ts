import { describe, expect, it } from 'vitest';

import { buildPrompt, decideFrontend } from './dispatch.js';
import type { DispatchInput } from './dispatch.js';

function input(overrides: Partial<DispatchInput>): DispatchInput {
  return {
    hasPromptArg: false,
    print: false,
    outputFormat: 'text',
    stdinIsTty: true,
    stdoutIsTty: true,
    env: {},
    platform: 'darwin',
    ...overrides,
  };
}

describe('decideFrontend', () => {
  it('bare hc on a real terminal → tui', () => {
    expect(decideFrontend(input({}))).toBe('tui');
  });

  it('a prompt argument is always one-shot', () => {
    expect(decideFrontend(input({ hasPromptArg: true }))).toBe('oneshot');
  });

  it('-p/--print forces one-shot even on a TTY', () => {
    expect(decideFrontend(input({ print: true }))).toBe('oneshot');
  });

  it('a non-text output format forces one-shot', () => {
    expect(decideFrontend(input({ outputFormat: 'json' }))).toBe('oneshot');
    expect(decideFrontend(input({ outputFormat: 'stream-json' }))).toBe('oneshot');
  });

  it('piped stdin (not a TTY) is one-shot', () => {
    expect(decideFrontend(input({ stdinIsTty: false }))).toBe('oneshot');
  });

  it('HC_NO_TUI=1 falls back to the REPL', () => {
    expect(decideFrontend(input({ env: { HC_NO_TUI: '1' } }))).toBe('repl');
  });

  it('a dumb terminal falls back to the REPL', () => {
    expect(decideFrontend(input({ env: { TERM: 'dumb' } }))).toBe('repl');
  });

  it('non-TTY stdout falls back to the REPL', () => {
    expect(decideFrontend(input({ stdoutIsTty: false }))).toBe('repl');
  });

  it('old Windows console without WT_SESSION falls back to the REPL', () => {
    expect(decideFrontend(input({ platform: 'win32', env: {} }))).toBe('repl');
    expect(decideFrontend(input({ platform: 'win32', env: { WT_SESSION: '1' } }))).toBe('tui');
  });
});

describe('buildPrompt', () => {
  it('joins a prompt arg and piped stdin as a tagged block', () => {
    expect(buildPrompt('fix the bug', 'error log\nlines')).toBe(
      'fix the bug\n\n<stdin>\nerror log\nlines\n</stdin>',
    );
  });

  it('uses stdin alone as the prompt', () => {
    expect(buildPrompt(undefined, '  hello  ')).toBe('hello');
  });

  it('uses the argument alone', () => {
    expect(buildPrompt('do the thing', undefined)).toBe('do the thing');
  });

  it('returns undefined when nothing was given', () => {
    expect(buildPrompt(undefined, undefined)).toBeUndefined();
    expect(buildPrompt('', '')).toBeUndefined();
  });
});
