import { describe, expect, it } from 'vitest';

import { PromptToolParser, partialTagSuffixLength, renderToolPrompt } from './prompt-tools.js';

/** Feed a string one character at a time — the worst case for tag detection. */
function streamChars(text: string) {
  const parser = new PromptToolParser();
  let visible = '';
  const calls = [];
  for (const ch of text) {
    const out = parser.push(ch);
    visible += out.text;
    calls.push(...out.calls);
  }
  const end = parser.end();
  visible += end.text;
  calls.push(...end.calls);
  return { visible, calls };
}

describe('PromptToolParser', () => {
  it('passes plain text straight through', () => {
    const { visible, calls } = streamChars('Here is the answer.');
    expect(visible).toBe('Here is the answer.');
    expect(calls).toEqual([]);
  });

  it('extracts a call and never leaks tag markup into visible text', () => {
    const { visible, calls } = streamChars(
      'Let me look.\n<tool_call>\n{"name":"read","arguments":{"path":"a.ts"}}\n</tool_call>\n',
    );

    expect(visible).not.toContain('tool_call');
    expect(visible.trim()).toBe('Let me look.');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'read', input: { path: 'a.ts' } });
  });

  it('extracts several calls emitted back to back', () => {
    const { calls } = streamChars(
      '<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>' +
        '<tool_call>{"name":"read","arguments":{"path":"b"}}</tool_call>',
    );

    expect(calls.map((c) => c.input)).toEqual([{ path: 'a' }, { path: 'b' }]);
    expect(new Set(calls.map((c) => c.id)).size).toBe(2);
  });

  it('accepts the alternate argument key names models drift to', () => {
    const { calls } = streamChars('<tool_call>{"name":"bash","parameters":{"cmd":"ls"}}</tool_call>');
    expect(calls[0]).toMatchObject({ name: 'bash', input: { cmd: 'ls' } });
  });

  it('salvages a call the stream cut off mid-payload', () => {
    const { calls } = streamChars('<tool_call>{"name":"read","arguments":{"path":"a.t');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'read', input: { path: 'a.t' } });
  });

  it('flags a payload that carries no name rather than calling nothing', () => {
    const { calls } = streamChars('<tool_call>{"arguments":{}}</tool_call>');
    expect(calls[0]?.parseError).toBeDefined();
  });

  it('does not hold back text that merely looks like a tag prefix', () => {
    // `<to` could still become `<tool_call>`, but `<toX` cannot — release it.
    const parser = new PromptToolParser();
    expect(parser.push('a<to').text).toBe('a');
    expect(parser.push('X').text).toBe('<toX');
  });

  it('releases a held-back prefix at end of stream', () => {
    const parser = new PromptToolParser();
    parser.push('done<tool');
    expect(parser.end().text).toBe('<tool');
  });

  it('streams visible text incrementally rather than buffering to the end', () => {
    const parser = new PromptToolParser();
    // 200 characters of prose must not be withheld waiting for a possible tag.
    const emitted = parser.push('x'.repeat(200)).text;
    expect(emitted.length).toBe(200);
  });
});

describe('partialTagSuffixLength', () => {
  it('finds the longest suffix that is a tag prefix', () => {
    expect(partialTagSuffixLength('hello<tool', '<tool_call>')).toBe(5);
    expect(partialTagSuffixLength('hello<', '<tool_call>')).toBe(1);
    expect(partialTagSuffixLength('hello', '<tool_call>')).toBe(0);
  });
});

describe('renderToolPrompt', () => {
  it('names every tool and includes its schema', () => {
    const prompt = renderToolPrompt([
      {
        name: 'read',
        description: 'Read a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]);

    expect(prompt).toContain('### read');
    expect(prompt).toContain('Read a file');
    expect(prompt).toContain('"path"');
    expect(prompt).toContain('<tool_call>');
  });
});
