import type { PermissionRule } from './types.js';

/** Collapse `.//foo` and `./foo` into a posix-ish relative form. Does not resolve `..`. */
export function normalizeRelPath(path: string): string {
  let s = path.replace(/\\/g, '/');
  if (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/\/+/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * A path that still contains `..` segments or is absolute is not a workspace-relative
 * glob candidate — those must be rejected by the path cage, not matched by `**`.
 */
export function isWorkspaceRelCandidate(path: string): boolean {
  const n = normalizeRelPath(path);
  if (n.startsWith('/') || n === '..' || n.startsWith('../')) return false;
  const parts = n.split('/');
  return !parts.includes('..');
}

export function globToRegExp(glob: string): RegExp {
  const n = normalizeRelPath(glob);
  let re = '';
  for (let i = 0; i < n.length; i++) {
    if (n.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 2;
      continue;
    }
    if (n.startsWith('**', i) && i + 2 === n.length) {
      re += '.*';
      i += 1;
      continue;
    }
    const c = n[i] ?? '';
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += escapeRegex(c);
  }
  return new RegExp(`^${re}$`);
}

export function matchPathGlob(relPath: string, pattern: string): boolean {
  if (!isWorkspaceRelCandidate(relPath)) return false;
  return globToRegExp(pattern).test(normalizeRelPath(relPath));
}

/**
 * Match a parsed argv against a Bash(specifier) pattern.
 * `git status:*` is Claude Code prefix-glob: `git status` plus optional extra args.
 */
export function matchBashPattern(argv: string[], pattern: string): boolean {
  const joined = argv.join(' ');
  const glob = pattern.endsWith(':*') ? `${pattern.slice(0, -2)}*` : pattern;
  return globToRegExp(glob).test(joined);
}

export function ruleMatchesTool(rule: PermissionRule, toolName: string): boolean {
  return rule.tool === toolName.toLowerCase();
}

export function ruleMatchesPath(rule: PermissionRule, toolName: string, relPath: string): boolean {
  if (!ruleMatchesTool(rule, toolName)) return false;
  if (rule.pattern === undefined) return isWorkspaceRelCandidate(relPath);
  return matchPathGlob(relPath, rule.pattern);
}

export function ruleMatchesBash(rule: PermissionRule, argv: string[]): boolean {
  if (!ruleMatchesTool(rule, 'bash')) return false;
  if (rule.pattern === undefined) return true;
  return matchBashPattern(argv, rule.pattern);
}

function escapeRegex(s: string): string {
  return s.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}
