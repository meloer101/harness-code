/**
 * Parse an inclusive integer range like "3-7" into [3, 4, 5, 6, 7].
 * Throws on malformed input, an inverted range, or a span wider than 1000.
 */
export function parseRange(input) {
  const match = /^(\d+)-(\d+)$/.exec(input.trim());
  if (!match) throw new Error(`bad range: ${input}`);
  const lo = Number(match[1]);
  const hi = Number(match[2]);
  if (hi < lo) throw new Error(`inverted range: ${input}`);
  if (hi - lo > 1000) throw new Error(`range too wide: ${input}`);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}
