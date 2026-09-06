import { describe, expect, it } from 'vitest';

import { parseRule } from './parse.js';

describe('parseRule', () => {
  it('parses a bare tool name case-insensitively', () => {
    expect(parseRule('Write')).toEqual({ tool: 'write', raw: 'Write' });
    expect(parseRule('bash')).toEqual({ tool: 'bash', raw: 'bash' });
  });

  it('parses Tool(specifier) including spaces and :*', () => {
    expect(parseRule('Bash(git status:*)')).toEqual({
      tool: 'bash',
      pattern: 'git status:*',
      raw: 'Bash(git status:*)',
    });
    expect(parseRule('Read(./src/**)')).toEqual({
      tool: 'read',
      pattern: './src/**',
      raw: 'Read(./src/**)',
    });
  });

  it('rejects empty, unclosed, nameless, and empty-specifier rules', () => {
    expect(() => parseRule('')).toThrow(/empty/i);
    expect(() => parseRule('Bash(')).toThrow(/closing/i);
    expect(() => parseRule('(./src/**)')).toThrow(/tool name/i);
    expect(() => parseRule('Bash()')).toThrow(/empty specifier/i);
    expect(() => parseRule('1read')).toThrow(/not valid/i);
  });
});
