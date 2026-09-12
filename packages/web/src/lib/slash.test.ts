import { describe, expect, it } from 'vitest';

import { allCommands, filterCommands, slashQuery } from './slash';

describe('slashQuery', () => {
  it('opens on a bare /token and closes once arguments start', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/comp')).toBe('comp');
    expect(slashQuery('/compact ')).toBeNull();
    expect(slashQuery('/mcp foo')).toBeNull();
  });

  it('stays closed for ordinary text', () => {
    expect(slashQuery('')).toBeNull();
    expect(slashQuery('hello /compact')).toBeNull();
    expect(slashQuery('a/b')).toBeNull();
  });
});

describe('allCommands / filterCommands', () => {
  it('merges client, server, and MCP prompts', () => {
    const cmds = allCommands([{ command: 'review', server: 'gh', name: 'review' }]);
    expect(cmds.map((c) => c.name)).toEqual(['help', 'clear', 'compact', 'plan', 'review']);
    expect(cmds.at(-1)).toMatchObject({ source: 'mcp', hint: 'gh prompt' });
  });

  it('ranks prefix matches above substring matches', () => {
    const cmds = allCommands([{ command: 'recompact', server: 'x', name: 'recompact' }]);
    expect(filterCommands(cmds, 'comp').map((c) => c.name)).toEqual(['compact', 'recompact']);
    expect(filterCommands(cmds, '')).toHaveLength(cmds.length);
    expect(filterCommands(cmds, 'zzz')).toEqual([]);
  });
});
