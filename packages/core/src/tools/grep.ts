import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import fg from 'fast-glob';
import { z } from 'zod';

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

async function grepWithRipgrep(
  input: Input,
  searchPath: string,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const args = ['--line-number', '--no-heading', '--max-count', '50'];
  if (input.ignoreCase) args.push('--ignore-case');
  if (input.glob) args.push('--glob', input.glob);
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
        const lines = stdout.split('\n').filter((l) => l !== '');
        resolvePromise({
          content: lines.length > 0 ? lines.slice(0, MAX_MATCHES).join('\n') : '(no matches)',
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

  const files = await fg(input.glob ?? '**/*', {
    cwd: searchPath,
    dot: true,
    onlyFiles: true,
    absolute: true,
    ignore: ['**/node_modules/**', '**/.git/**'],
  });

  const matches: string[] = [];
  for (const file of files) {
    if (matches.length >= MAX_MATCHES) break;
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue; // binary or unreadable; skip rather than fail the whole search
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
      if (regex.test(lines[i] ?? '')) matches.push(`${file}:${i + 1}:${lines[i]}`);
    }
  }
  return { content: matches.length > 0 ? matches.join('\n') : '(no matches)' };
}
