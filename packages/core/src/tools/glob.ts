import { resolve } from 'node:path';

import fg from 'fast-glob';
import { z } from 'zod';

import { PathEscapeError, assertInsideWorkspace } from '../permissions/paths.js';
import type { ToolSpec } from './types.js';
import { errorMessage } from './util.js';

const schema = z.object({
  pattern: z.string().describe('Glob pattern, e.g. "src/**/*.ts".'),
  cwd: z
    .string()
    .optional()
    .describe('Directory to search from, relative to the workspace root.'),
});

export const globTool: ToolSpec<z.infer<typeof schema>> = {
  name: 'glob',
  description: 'Find files matching a glob pattern.',
  schema,
  readOnly: true,
  concurrencySafe: true,
  async execute(input, ctx) {
    const requested = input.cwd ? resolve(ctx.cwd, input.cwd) : ctx.cwd;
    let cwd: string;
    try {
      cwd = await assertInsideWorkspace(ctx.cwd, requested);
    } catch (err) {
      const message = err instanceof PathEscapeError ? err.message : errorMessage(err);
      return { content: message, isError: true };
    }
    const matches = await fg(input.pattern, { cwd, dot: true, onlyFiles: true });
    matches.sort();
    return { content: matches.length > 0 ? matches.join('\n') : '(no matches)' };
  },
};
