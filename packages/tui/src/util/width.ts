/**
 * CJK-width-safe string measurement and truncation.
 *
 * Every display-width computation in `src/components/` must go through these —
 * never `.length` / `.slice()`. `string-width` counts fullwidth CJK as 2 columns
 * and `cli-truncate` cuts on display width, so `│` gutters and right-aligned
 * meters stay aligned with mixed CJK/ASCII content.
 */

import cliTruncate from 'cli-truncate';
import stringWidth from 'string-width';

export function width(s: string): number {
  return stringWidth(s);
}

export function truncate(
  s: string,
  max: number,
  position: 'start' | 'middle' | 'end' = 'end',
): string {
  if (width(s) <= max) return s;
  return cliTruncate(s, max, { position });
}

export function pad(s: string, w: number, align: 'left' | 'right' = 'left'): string {
  const n = Math.max(0, w - width(s));
  const fill = ' '.repeat(n);
  return align === 'right' ? fill + s : s + fill;
}
