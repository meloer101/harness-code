/**
 * Mid-stream, the model's markdown is usually cut off inside a code fence;
 * parsed as-is, everything after the opening ``` flips to plain text and back
 * on every frame. Closing the dangling fence keeps the render stable (the
 * idea behind opencode's `remend`, just the one case that matters).
 */
export function closeOpenFences(text: string): string {
  let open: string | null = null;
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!m?.[1]) continue;
    const fence = m[1];
    if (open === null) open = fence;
    else if (fence[0] === open[0] && fence.length >= open.length && line.trim() === fence) open = null;
  }
  if (open === null) return text;
  return `${text}${text.endsWith('\n') ? '' : '\n'}${open}`;
}
