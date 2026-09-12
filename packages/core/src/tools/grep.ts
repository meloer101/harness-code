import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import fg from 'fast-glob';
import ignore from 'ignore';
import { z } from 'zod';

import { truncateHeadTail, truncateList } from '../context/truncate.js';
import { PathEscapeError, assertInsideWorkspace } from '../permissions/paths.js';
import type { ToolResult, ToolSpec } from './types.js';
import { errorMessage } from './util.js';

const schema = z.object({
  pattern: z.string().describe('Regular expression to search for.'),
  path: z
    .string()
    .optional()
    .describe('Directory or file to search, relative to the workspace root.'),
  glob: z.string().optional().describe('Restrict the search to files matching this glob.'),
  ignoreCase: z.boolean().optional(),
});

type Input = z.infer<typeof schema>;

const MAX_MATCHES = 200;
/** A single match line longer than this is clamped — one minified line can be megabytes. */
const MAX_LINE_CHARS = 500;
/** Whole-result ceiling, independent of the line count. Guards against many long-ish lines. */
const MAX_TOTAL_CHARS = 100_000;

/**
 * Directories and files a content search should never descend into. `rg`
 * already honours `.gitignore`; the JS fallback does not, so this is where the
 * two are kept roughly in step. Includes `.agent/` — the harness's own session
 * logs contain multi-megabyte single lines.
 */
const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.agent/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.cache/**',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.tsbuildinfo',
];

export const grepTool: ToolSpec<Input> = {
  name: 'grep',
  description:
    'Search file contents for a regular expression. Prefers ripgrep when it is installed, ' +
    'otherwise falls back to a plain JS scan.',
  schema,
  readOnly: true,
  concurrencySafe: true,
  async execute(input, ctx) {
    const requested = input.path ? resolve(ctx.cwd, input.path) : ctx.cwd;
    let searchPath: string;
    try {
      searchPath = await assertInsideWorkspace(ctx.cwd, requested);
    } catch (err) {
      const message = err instanceof PathEscapeError ? err.message : errorMessage(err);
      return { content: message, isError: true };
    }
    try {
      return await grepWithRipgrep(input, searchPath, ctx.signal);
    } catch (err) {
      if (!isEnoent(err)) throw err;
      return grepWithJs(input, searchPath);
    }
  },
};

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/** Clamp one match line so a single giant line cannot dominate the result. */
function clampLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return `${line.slice(0, MAX_LINE_CHARS)} … +${line.length - MAX_LINE_CHARS} chars`;
}

/** Apply the whole-result ceiling, keeping head and tail. */
function capTotal(text: string): string {
  return truncateHeadTail(text, { maxChars: MAX_TOTAL_CHARS, headChars: 80_000, tailChars: 15_000 })
    .text;
}

async function grepWithRipgrep(
  input: Input,
  searchPath: string,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const args = ['--line-number', '--no-heading', '--max-count', '50'];
  if (input.ignoreCase) args.push('--ignore-case');
  if (input.glob) args.push('--glob', input.glob);
  for (const g of ['.agent', 'dist', 'coverage', '*.min.js', '*.min.css', '*.map']) {
    args.push('--glob', `!${g}`);
  }
  args.push(input.pattern, searchPath);

  return new Promise((resolvePromise, reject) => {
    const child = spawn('rg', args, signal ? { signal } : {});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      // rg exits 1 when there are simply no matches; that is not a tool error.
      if (code === 0 || code === 1) {
        const lines = stdout.split('\n').filter((l) => l !== '').map(clampLine);
        resolvePromise({
          content:
            lines.length > 0
              ? capTotal(truncateList(lines, MAX_MATCHES, { noun: 'matches' }).text)
              : '(no matches)',
        });
      } else {
        resolvePromise({ content: `rg exited with code ${code}: ${stderr}`, isError: true });
      }
    });
  });
}

/** Exported so tests can exercise the fallback deterministically, without depending on
 *  whether `rg` happens to be on the machine running them. */
export async function grepWithJs(input: Input, searchPath: string): Promise<ToolResult> {
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, input.ignoreCase ? 'i' : '');
  } catch (err) {
    return { content: `Invalid regular expression: ${errorMessage(err)}`, isError: true };
  }

  const found = await fg(input.glob ?? '**/*', {
    cwd: searchPath,
    dot: true,
    onlyFiles: true,
    absolute: true,
    ignore: DEFAULT_IGNORE,
  });
  const matcher = await gitignoreMatcher(searchPath);
  const files = matcher ? found.filter((f) => !isGitignored(matcher, f)) : found;

  const matches: string[] = [];
  let hitCap = false;
  let totalChars = 0;
  for (const file of files) {
    if (hitCap) break;
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue; // binary or unreadable; skip rather than fail the whole search
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_MATCHES || totalChars >= MAX_TOTAL_CHARS) {
        hitCap = true; // there was at least one more line to scan
        break;
      }
      if (regex.test(lines[i] ?? '')) {
        const entry = `${file}:${i + 1}:${clampLine(lines[i] ?? '')}`;
        matches.push(entry);
        totalChars += entry.length + 1;
      }
    }
  }
  if (matches.length === 0) return { content: '(no matches)' };
  return {
    content: capTotal(
      truncateList(matches, MAX_MATCHES, {
        noun: 'matches',
        total: matches.length,
        totalIsFloor: hitCap,
      }).text,
    ),
  };
}

/**
 * Best-effort `.gitignore` support for the JS fallback: walk up from the
 * search path and load the first `.gitignore` found through the `ignore`
 * package, which implements real gitignore semantics (negation, character
 * classes, directory-only patterns) instead of a hand-rolled glob conversion —
 * a from-scratch parser previously dropped `!` lines entirely, silently
 * re-admitting whatever they were meant to un-ignore.
 */
async function gitignoreMatcher(
  searchPath: string,
): Promise<{ dir: string; ig: ReturnType<typeof ignore> } | undefined> {
  let dir = searchPath;
  for (let depth = 0; depth < 6; depth++) {
    try {
      const raw = await readFile(join(dir, '.gitignore'), 'utf8');
      return { dir, ig: ignore().add(raw) };
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

function isGitignored(
  matcher: { dir: string; ig: ReturnType<typeof ignore> },
  absolutePath: string,
): boolean {
  const rel = relative(matcher.dir, absolutePath).split(sep).join('/');
  return rel !== '' && !rel.startsWith('..') && matcher.ig.ignores(rel);
}
