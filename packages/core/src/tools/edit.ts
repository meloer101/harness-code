import { readFile, stat, writeFile } from 'node:fs/promises';

import { z } from 'zod';

import { PathEscapeError, assertInsideWorkspace } from '../permissions/paths.js';
import type { ToolSpec } from './types.js';
import { errorMessage } from './util.js';

const schema = z.object({
  path: z.string().describe('File path to edit, relative to the workspace root or absolute.'),
  oldString: z.string().min(1).describe('Exact text to replace.'),
  newString: z.string().describe('Text to replace it with.'),
  replaceAll: z
    .boolean()
    .optional()
    .describe('Replace every occurrence instead of requiring a single unique match.'),
});

export const editTool: ToolSpec<z.infer<typeof schema>> = {
  name: 'edit',
  description:
    'Replace an exact string in a file that was previously read. oldString must match ' +
    'exactly one place unless replaceAll is set — include enough surrounding context to ' +
    'make it unique.',
  schema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input, ctx) {
    let path: string;
    try {
      path = await assertInsideWorkspace(ctx.cwd, input.path);
    } catch (err) {
      const message = err instanceof PathEscapeError ? err.message : errorMessage(err);
      return { content: message, isError: true };
    }
    if (!ctx.session.hasRead(path)) {
      return { content: `Refusing to edit ${input.path}: read it first.`, isError: true };
    }

    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      return { content: `Could not read ${input.path}: ${errorMessage(err)}`, isError: true };
    }

    const occurrences = countOccurrences(text, input.oldString);
    if (occurrences === 0) {
      return { content: `oldString not found in ${input.path}.`, isError: true };
    }
    if (occurrences > 1 && !input.replaceAll) {
      return {
        content:
          `oldString matches ${occurrences} places in ${input.path}; include more ` +
          `surrounding context to make it unique, or pass replaceAll: true.`,
        isError: true,
      };
    }

    const updated = input.replaceAll
      ? text.split(input.oldString).join(input.newString)
      : text.replace(input.oldString, input.newString);

    try {
      await writeFile(path, updated, 'utf8');
    } catch (err) {
      return { content: `Could not write ${input.path}: ${errorMessage(err)}`, isError: true };
    }

    const stats = await stat(path);
    ctx.session.markRead(path, stats.mtimeMs);
    return { content: `Replaced ${occurrences} occurrence(s) in ${input.path}` };
  },
};

function countOccurrences(text: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let index = 0;
  for (;;) {
    const found = text.indexOf(needle, index);
    if (found === -1) break;
    count++;
    index = found + needle.length;
  }
  return count;
}
