/**
 * Prompt-cache stability.
 *
 * Every endpoint this harness talks to (DeepSeek, OpenAI, …) does automatic
 * prefix caching: an identical leading run of tokens is served from cache at a
 * fraction of the price. One token changes and everything from there is a miss.
 * The only lever we have on the OpenAI-compatible surface is keeping the prefix
 * byte-identical across turns — there is nothing to configure, just an ordering
 * discipline to hold. (`SystemSegment.cacheBreakpoint` is inert here; it exists
 * for the native Anthropic provider in Phase 7, which needs explicit
 * `cache_control` markers.)
 *
 * `SYSTEM_SEGMENT_ORDER` makes that discipline a checked contract rather than a
 * convention someone can quietly break by pushing a segment in the wrong place.
 */

import type { SystemSegment } from '../provider/types.js';

/**
 * Canonical order for system segments, most stable first. `identity` and
 * `conventions` never change; `available_skills`, `available_memory`, and
 * `project_memory` are fixed per project; `plan_mode` and `environment` vary
 * by mode / cwd and go last so the cacheable head stays put.
 */
export const SYSTEM_SEGMENT_ORDER = [
  'identity',
  'conventions',
  'agent_role',
  'available_skills',
  'available_memory',
  'project_memory',
  'plan_mode',
  'environment',
] as const;

/**
 * Return `segments` in `SYSTEM_SEGMENT_ORDER`. Unknown ids keep their relative
 * order and go after all known ones. Stable sort — segments with the same rank
 * are not reordered.
 */
export function orderSystemSegments(segments: readonly SystemSegment[]): SystemSegment[] {
  const rank = (id: string): number => {
    const i = (SYSTEM_SEGMENT_ORDER as readonly string[]).indexOf(id);
    return i === -1 ? SYSTEM_SEGMENT_ORDER.length : i;
  };
  return segments
    .map((seg, i) => ({ seg, i }))
    .sort((a, b) => rank(a.seg.id) - rank(b.seg.id) || a.i - b.i)
    .map(({ seg }) => seg);
}

/** Fraction of input tokens served from the prompt cache this turn/session. */
export function cacheHitRate(usage: { inputTokens: number; cachedInputTokens: number }): number {
  return usage.inputTokens > 0 ? usage.cachedInputTokens / usage.inputTokens : 0;
}
