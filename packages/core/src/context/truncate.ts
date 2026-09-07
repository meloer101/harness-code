/**
 * Tool-output truncation, shared by `bash` / `grep` / `read`.
 *
 * A tool result that dwarfs the context window both burns tokens and dilutes
 * attention (context rot). Two shapes:
 *
 * - `truncateHeadTail` — keep the start and the end of a large blob, drop the
 *   middle. Errors tend to be at the end, orientation at the start. Cut points
 *   snap to line boundaries so a line is never sheared.
 * - `truncateList` — keep the first N of many items and say how many there
 *   were, so the model knows to narrow its query rather than assuming it saw
 *   everything.
 *
 * Both leave a marker that says what was dropped and, implicitly, that there is
 * more — the "restorable" property: the model can always ask again more
 * narrowly.
 */

export interface TruncateResult {
  text: string;
  truncated: boolean;
  omittedChars: number;
  omittedLines: number;
}

export interface HeadTailOptions {
  /** Truncate only once the text exceeds this. Default 30_000. */
  maxChars?: number;
  /** Characters to keep from the start. Default 20_000. */
  headChars?: number;
  /** Characters to keep from the end. Default 8_000. */
  tailChars?: number;
}

const DEFAULT_MAX = 30_000;
const DEFAULT_HEAD = 20_000;
const DEFAULT_TAIL = 8_000;
/** How far a cut point may move to land on a line boundary before we just hard-cut. */
const SNAP_LIMIT = 2_000;

export function truncateHeadTail(text: string, opts: HeadTailOptions = {}): TruncateResult {
  const maxChars = opts.maxChars ?? DEFAULT_MAX;
  const headChars = opts.headChars ?? DEFAULT_HEAD;
  const tailChars = opts.tailChars ?? DEFAULT_TAIL;

  if (text.length <= maxChars) {
    return { text, truncated: false, omittedChars: 0, omittedLines: 0 };
  }

  // Head ends at headChars, nudged forward to finish the current line if a
  // newline is close by; likewise the tail starts at len-tailChars nudged back
  // to a line start. A blob with no nearby newline (one giant line) hard-cuts.
  let headEnd = headChars;
  const nlAfter = text.indexOf('\n', headChars);
  if (nlAfter !== -1 && nlAfter - headChars <= SNAP_LIMIT) headEnd = nlAfter + 1;

  let tailStart = text.length - tailChars;
  const nlBefore = text.lastIndexOf('\n', tailStart);
  if (nlBefore !== -1 && tailStart - nlBefore <= SNAP_LIMIT) tailStart = nlBefore + 1;

  if (tailStart <= headEnd) {
    // Head and tail overlap after snapping — just keep the head.
    const omittedChars = text.length - headChars;
    return {
      text: `${text.slice(0, headChars)}\n… ${omittedChars} characters omitted …\n`,
      truncated: true,
      omittedChars,
      omittedLines: countLines(text.slice(headChars)),
    };
  }

  const omittedChars = tailStart - headEnd;
  const omittedLines = countLines(text.slice(headEnd, tailStart));
  return {
    text:
      `${text.slice(0, headEnd)}\n… ${omittedChars} characters / ${omittedLines} lines omitted …\n\n` +
      text.slice(tailStart),
    truncated: true,
    omittedChars,
    omittedLines,
  };
}

function countLines(s: string): number {
  if (s === '') return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') n++;
  return n;
}

export interface ListTruncateResult {
  text: string;
  shown: number;
  total: number;
  /** True when `total` is a floor ("at least"), not an exact count. */
  totalIsFloor: boolean;
}

/**
 * Join `items` with newlines, keeping at most `max`. When there are more (or the
 * caller only knows there are *at least* this many, via `totalIsFloor`), append
 * a line saying so.
 */
export function truncateList(
  items: readonly string[],
  max: number,
  opts: { noun?: string; totalIsFloor?: boolean; total?: number } = {},
): ListTruncateResult {
  const noun = opts.noun ?? 'results';
  const total = opts.total ?? items.length;
  const totalIsFloor = opts.totalIsFloor ?? false;

  if (!totalIsFloor && total <= max) {
    return { text: items.join('\n'), shown: total, total, totalIsFloor: false };
  }

  const shown = Math.min(max, items.length);
  const count = totalIsFloor ? `at least ${total}` : `${total}`;
  return {
    text:
      `${items.slice(0, shown).join('\n')}\n` +
      `… showing ${shown} of ${count} ${noun} — narrow the query (path / glob / a tighter pattern) to see the rest`,
    shown,
    total,
    totalIsFloor,
  };
}
