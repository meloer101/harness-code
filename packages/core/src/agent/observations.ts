/**
 * Optional structural jitter on newly-created tool_result bodies so a long
 * session of identical observation templates does not few-shot the model into
 * a stale pattern (Manus). Off by default; never rewrites history.
 */

import { PRUNED_TOOL_RESULT_PREFIX } from '../context/compactor.js';
import type { ToolResult } from '../tools/types.js';

const TEMPLATES: ReadonlyArray<(content: string) => string> = [
  (c) => c,
  (c) => `Result:\n${c}`,
  (c) => `[tool output]\n${c}`,
];

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function varyObservation(content: string, toolUseId: string): string {
  const i = hashId(toolUseId) % TEMPLATES.length;
  return TEMPLATES[i]!(content);
}

export function shouldVaryObservation(result: { content: string; isError?: boolean }): boolean {
  if (result.isError) return false;
  const c = result.content;
  if (c === '') return false;
  if (c.startsWith(PRUNED_TOOL_RESULT_PREFIX)) return false;
  if (c.startsWith('Denied:')) return false;
  if (c.startsWith('Unknown tool ')) return false;
  return true;
}

export function maybeVaryObservation(
  result: ToolResult | undefined,
  toolUseId: string,
  enabled: boolean,
): string {
  const content = result?.content ?? '';
  if (!enabled || !result || !shouldVaryObservation(result)) return content;
  return varyObservation(content, toolUseId);
}
