import { homedir } from 'node:os';
import { posix } from 'node:path';

import { parse } from 'shell-quote';
import type { ParseEntry } from 'shell-quote';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'python', 'python3', 'node', 'perl', 'ruby']);

export interface BashInspection {
  segments: string[][];
  hardDenyReason?: string;
}

type Token = ParseEntry;

export function inspectBash(command: string): BashInspection {
  const trimmed = command.trim();
  if (!trimmed) {
    return { segments: [], hardDenyReason: 'Empty command is not allowed' };
  }

  if (/\$\(/.test(command) || command.includes('`')) {
    return { segments: [], hardDenyReason: 'Command substitution is not allowed' };
  }

  let tokens: Token[];
  try {
    tokens = parse(command) as Token[];
  } catch {
    return { segments: [], hardDenyReason: 'Unable to safely parse this command' };
  }

  if (tokens.length === 0) {
    return { segments: [], hardDenyReason: 'Empty command is not allowed' };
  }
  if (tokens.some((t) => typeof t === 'object' && t !== null && 'comment' in t)) {
    // comments are fine; strip them
    tokens = tokens.filter((t) => !(typeof t === 'object' && t !== null && 'comment' in t));
  }

  const segments = splitSegments(tokens);
  if (segments.length === 0) {
    return { segments: [], hardDenyReason: 'Unable to safely parse this command' };
  }

  const reason =
    redirectToSsh(tokens) ??
    pipeToShell(segments) ??
    segments.map(hardDenySegment).find((r) => r !== undefined);

  const extra: string[][] = [];
  for (const argv of segments) {
    const inner = nestedShellCommand(argv);
    if (inner) {
      const nested = inspectBash(inner);
      if (nested.hardDenyReason) {
        return { segments, hardDenyReason: nested.hardDenyReason };
      }
      extra.push(...nested.segments);
    }
  }

  return {
    segments: extra.length > 0 ? [...segments, ...extra] : segments,
    ...(reason ? { hardDenyReason: reason } : {}),
  };
}

function splitSegments(tokens: Token[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  const push = (): void => {
    if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  };

  for (const token of tokens) {
    if (typeof token === 'string') {
      current.push(token);
      continue;
    }
    if ('op' in token) {
      if (token.op === 'glob') {
        current.push((token as { pattern: string }).pattern);
        continue;
      }
      if (token.op === '>' || token.op === '>>' || token.op === '<' || token.op === '>&' || token.op === '<&') {
        // keep going; destination is the next string token, still same command
        continue;
      }
      if (token.op === '(' || token.op === ')') {
        return []; // unhandled grouping — fail closed
      }
      push();
    }
  }
  push();
  return segments;
}

function redirectToSsh(tokens: Token[]): string | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (typeof token !== 'object' || token === null || !('op' in token)) continue;
    if (token.op !== '>' && token.op !== '>>') continue;
    const dest = tokens[i + 1];
    if (typeof dest === 'string' && isSshPath(dest)) {
      return `Writing to ${dest} is not allowed`;
    }
  }
  return undefined;
}

function pipeToShell(segments: string[][]): string | undefined {
  if (segments.length < 2) return undefined;
  for (let i = 1; i < segments.length; i++) {
    const cmd = segments[i]?.[0];
    if (cmd && SHELLS.has(baseCmd(cmd))) {
      return `Piping into ${baseCmd(cmd)} is not allowed`;
    }
  }
  return undefined;
}

function hardDenySegment(argv: string[]): string | undefined {
  if (argv.length === 0) return undefined;
  const cmd = baseCmd(argv[0] ?? '');

  for (const arg of argv) {
    if (isSshPath(arg)) {
      return `Accessing ${arg} is not allowed`;
    }
  }

  if (cmd === 'rm' && hasRecursiveForce(argv) && argv.slice(1).some(isCatastrophicRmTarget)) {
    return `Refusing recursive delete of ${argv.slice(1).filter(isCatastrophicRmTarget).join(', ')}`;
  }

  if (cmd === 'chmod' && argv.includes('777') && argv.some((a) => a === '/' || a === '/*')) {
    return 'chmod 777 / is not allowed';
  }

  return undefined;
}

function nestedShellCommand(argv: string[]): string | undefined {
  const cmd = baseCmd(argv[0] ?? '');
  if (!INTERPRETERS.has(cmd)) return undefined;
  const cIndex = argv.findIndex((a) => a === '-c');
  if (cIndex === -1) return undefined;
  return argv[cIndex + 1];
}

function hasRecursiveForce(argv: string[]): boolean {
  const flags = argv.filter((a) => a.startsWith('-') && a !== '-');
  const joined = flags.join('');
  return (joined.includes('r') || joined.includes('R')) && joined.includes('f');
}

function isCatastrophicRmTarget(arg: string): boolean {
  if (arg.startsWith('-')) return false;
  const home = homedir();
  if (arg === '/' || arg === '/*' || arg === '~' || arg === '$HOME' || arg === home) return true;
  if (arg === '~/' || arg === `${home}/`) return true;
  // outside-ish: absolute path that is not clearly a relative workspace path
  if (arg.startsWith('~/') || arg.startsWith('$HOME/')) return true;
  if (arg.startsWith('/') && arg !== '/tmp' && !arg.startsWith('/tmp/')) {
    // /tmp/x is not catastrophic in the hard-deny sense for rm of workspace-like dirs;
    // plan: only / , $HOME, or workspace-outside. inspectBash has no workspace, so
    // absolute paths other than /tmp are treated as outside.
    if (arg === '/' || posix.resolve(arg) === '/') return true;
    if (home && (arg === home || arg.startsWith(home + '/'))) return true;
    return true;
  }
  return false;
}

function isSshPath(arg: string): boolean {
  const n = arg.replace(/\\/g, '/');
  return (
    n === '~/.ssh' ||
    n.startsWith('~/.ssh/') ||
    n.includes('/.ssh/') ||
    n.endsWith('/.ssh') ||
    n.startsWith('$HOME/.ssh')
  );
}

function baseCmd(cmd: string): string {
  const n = cmd.replace(/\\/g, '/');
  const base = n.split('/').pop() ?? n;
  return base;
}
