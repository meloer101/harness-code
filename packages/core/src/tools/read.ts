import { readFile, stat } from 'node:fs/promises';

import { z } from 'zod';

import { PathEscapeError, assertInsideWorkspace } from '../permissions/paths.js';
import type { ToolSpec } from './types.js';
import { errorMessage } from './util.js';

const schema = z.object({
  path: z.string().describe('File path to read, relative to the workspace root or absolute.'),
  offset: z.number().int().min(1).optional().describe('1-based line number to start from.'),
  limit: z.number().int().min(1).optional().describe('Maximum number of lines to return.'),
});

const DEFAULT_LIMIT = 2000;

export const readTool: ToolSpec<z.infer<typeof schema>> = {
  name: 'read',
  description:
    'Read a file from the workspace, with line numbers (like `cat -n`). Paginate long ' +
    'files with offset/limit instead of reading them all at once.',
  schema,
  readOnly: true,
  concurrencySafe: true,
  async execute(input, ctx) {
    let path: string;
    try {
      path = await assertInsideWorkspace(ctx.cwd, input.path);
    } catch (err) {
      const message = err instanceof PathEscapeError ? err.message : errorMessage(err);
      return { content: message, isError: true };
    }
    let text: string;
    let mtimeMs: number;
    try {
      const [content, stats] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      text = content;
      mtimeMs = stats.mtimeMs;
    } catch (err) {
      return { content: `Could not read ${input.path}: ${errorMessage(err)}`, isError: true };
    }
    ctx.session.markRead(path, mtimeMs);

    const lines = text.split('\n');
    const start = Math.max(0, (input.offset ?? 1) - 1);
    const limit = input.limit ?? DEFAULT_LIMIT;
    const slice = lines.slice(start, start + limit);
    const rendered = slice
      .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
      .join('\n');
    const omitted = lines.length - (start + slice.length);
    const suffix =
      omitted > 0
        ? `\n... ${omitted} more line(s); pass offset ${start + slice.length + 1} to continue.`
        : '';
    return { content: rendered + suffix };
  },
};
