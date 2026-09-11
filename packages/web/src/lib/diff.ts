import { diffLines } from 'diff';

export type DiffLine = { kind: 'add' | 'del' | 'ctx'; text: string };

export interface LineDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
}

function splitLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Terminate the last line, so `"a"` → `"a\nb"` diffs as one added line, not a changed one. */
const withEol = (s: string): string => (s === '' || s.endsWith('\n') ? s : `${s}\n`);

/** Line diff of an `edit` call's `oldString` → `newString`. */
export function editDiff(oldString: string, newString: string): LineDiff {
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const part of diffLines(withEol(oldString), withEol(newString))) {
    const kind = part.added ? 'add' : part.removed ? 'del' : 'ctx';
    for (const text of splitLines(part.value)) {
      lines.push({ kind, text });
      if (kind === 'add') added++;
      else if (kind === 'del') removed++;
    }
  }
  return { lines, added, removed };
}

/** A `write` call's content as an all-added diff (the prior content isn't in the call). */
export function writeDiff(content: string): LineDiff {
  const lines = splitLines(content).map((text) => ({ kind: 'add' as const, text }));
  return { lines, added: lines.length, removed: 0 };
}
