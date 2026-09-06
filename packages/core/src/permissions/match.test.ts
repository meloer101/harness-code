import { describe, expect, it } from 'vitest';

import { matchBashPattern, matchPathGlob } from './match.js';
import { parseRule } from './parse.js';
import { ruleMatchesPath } from './match.js';

describe('matchPathGlob', () => {
  it('matches a file under ./src/**', () => {
    expect(matchPathGlob('./src/a.ts', './src/**')).toBe(true);
    expect(matchPathGlob('src/a.ts', './src/**')).toBe(true);
    expect(matchPathGlob('src/nested/b.ts', 'src/**')).toBe(true);
  });

  it('does not let ../secret match a workspace glob', () => {
    expect(matchPathGlob('../secret', './src/**')).toBe(false);
    expect(matchPathGlob('../secret', '**')).toBe(false);
    expect(matchPathGlob('../secret', './**')).toBe(false);
  });
});

describe('matchBashPattern', () => {
  it('matches git status against git status:*', () => {
    expect(matchBashPattern(['git', 'status'], 'git status:*')).toBe(true);
    expect(matchBashPattern(['git', 'status', '-sb'], 'git status:*')).toBe(true);
  });

  it('does not match a different command as a single segment', () => {
    expect(matchBashPattern(['rm', '-rf', '~'], 'git status:*')).toBe(false);
    expect(matchBashPattern(['git', 'push'], 'git status:*')).toBe(false);
  });
});

describe('ruleMatchesPath', () => {
  it('bare Read matches any workspace-relative path', () => {
    const rule = parseRule('Read');
    expect(ruleMatchesPath(rule, 'read', 'src/a.ts')).toBe(true);
    expect(ruleMatchesPath(rule, 'read', '../secret')).toBe(false);
  });
});
