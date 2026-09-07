/**
 * Context breakdown — where the tokens in the window actually go.
 *
 * The loop already tracks the *total* (anchored on real usage). This splits the
 * fixed part of that total into named buckets — system prompt, project memory,
 * tool schemas — so `history` can be read off as the remainder. The buckets are
 * stable within one `run()`, so the loop computes them once; nothing here
 * re-flattens the whole message list per turn.
 *
 * This is visibility only. A real allocator — per-bucket ceilings with
 * priority-ordered downgrade — waits for skills (Phase 6), which is the first
 * time more than one bucket is both large and sheddable.
 */

import type { SystemSegment, ToolDefinition } from '../provider/types.js';
import { heuristicTokenCount, type TokenCounter } from './tokenizer.js';

export interface ContextBreakdown {
  system: number;
  projectMemory: number;
  toolSchemas: number;
  history: number;
  total: number;
}

/** The id of the system segment that carries AGENTS.md / CLAUDE.md content. */
export const PROJECT_MEMORY_SEGMENT_ID = 'project_memory';

export interface StableParts {
  system: number;
  projectMemory: number;
  toolSchemas: number;
}

/**
 * Token weight of the parts that do not change across a run: the system prompt
 * (with the project-memory segment counted separately) and the tool schemas.
 * The text model matches `flattenRequestText` so the numbers reconcile with the
 * loop's anchor.
 */
export function analyzeStableParts(
  req: { system?: readonly SystemSegment[]; tools?: readonly ToolDefinition[] },
  count: TokenCounter = heuristicTokenCount,
): StableParts {
  let system = 0;
  let projectMemory = 0;
  for (const seg of req.system ?? []) {
    const n = count(seg.text);
    if (seg.id === PROJECT_MEMORY_SEGMENT_ID) projectMemory += n;
    else system += n;
  }
  const toolSchemas = count(
    (req.tools ?? []).map((t) => t.description + JSON.stringify(t.inputSchema)).join(''),
  );
  return { system, projectMemory, toolSchemas };
}

/** Combine the fixed buckets with the running total to get the full breakdown. */
export function breakdownFrom(stable: StableParts, totalTokens: number): ContextBreakdown {
  const history = Math.max(0, totalTokens - stable.system - stable.projectMemory - stable.toolSchemas);
  return { ...stable, history, total: totalTokens };
}
