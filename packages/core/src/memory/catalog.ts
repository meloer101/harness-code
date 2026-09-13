/**
 * The set of memory entries available this session, collapsed into the
 * `<available_memory>` system segment.
 *
 * Progressive disclosure tier 1: one line per entry reaches the system prompt.
 * `MAX_MEMORY_MANIFEST_TOKENS` caps that segment — overflow goes to `dropped`
 * and stays loadable by exact path via the `memory` tool. Same budget algorithm
 * as `SkillCatalog` (empty-skeleton baseline, first entry never dropped).
 */

import { heuristicTokenCount, type TokenCounter } from '../context/tokenizer.js';
import type { MemoryEntry } from './types.js';

export const MAX_MEMORY_MANIFEST_TOKENS = 1000;

export const MANIFEST_PREAMBLE =
  'Standing notes accumulated across sessions — about this user, this project, and ' +
  'how to collaborate on different kinds of tasks. Read an entry with the `memory` tool ' +
  "before assuming it's still accurate. Write one when you learn something that will " +
  'matter in a future session and is not already derivable from the code, git history, ' +
  'or AGENTS.md/CLAUDE.md. Check existing entries before writing — update, don\'t duplicate. ' +
  'Prefer project scope for this codebase; global only for something true in every project.';

/** `<available_memory>` even when the catalog is empty, so the model still sees write policy. */
export function emptyMemoryManifest(): string {
  return `<available_memory>\n${MANIFEST_PREAMBLE}\n</available_memory>`;
}

export function manifestLine(entry: MemoryEntry): string {
  return `- ${entry.path} [${entry.type}, ${entry.scope}]: ${entry.description}`;
}

export class MemoryCatalog {
  private readonly byPath = new Map<string, MemoryEntry>();
  /** Relative paths included in the manifest (a prefix of constructor order after the token cap). */
  readonly advertised: string[];
  readonly dropped: string[];

  constructor(entries: readonly MemoryEntry[], count: TokenCounter = heuristicTokenCount) {
    for (const e of entries) {
      if (!this.byPath.has(e.path)) this.byPath.set(e.path, e);
    }

    const advertised: string[] = [];
    const dropped: string[] = [];
    let running = count(`<available_memory>\n${MANIFEST_PREAMBLE}\n\n</available_memory>`);
    for (const e of this.byPath.values()) {
      const line = `${manifestLine(e)}\n`;
      const cost = count(line);
      if (advertised.length > 0 && running + cost > MAX_MEMORY_MANIFEST_TOKENS) {
        dropped.push(e.path);
      } else {
        advertised.push(e.path);
        running += cost;
      }
    }
    this.advertised = advertised;
    this.dropped = dropped;
  }

  get size(): number {
    return this.byPath.size;
  }

  list(): MemoryEntry[] {
    return [...this.byPath.values()];
  }

  get(path: string): MemoryEntry | undefined {
    return this.byPath.get(path);
  }

  /** The `<available_memory>` segment text, or `undefined` when nothing is advertised. */
  manifest(): string | undefined {
    if (this.advertised.length === 0) return undefined;
    const lines = this.advertised.map((p) => manifestLine(this.byPath.get(p)!));
    return `<available_memory>\n${MANIFEST_PREAMBLE}\n\n${lines.join('\n')}\n</available_memory>`;
  }

  manifestTokens(count: TokenCounter = heuristicTokenCount): number {
    const m = this.manifest();
    return m ? count(m) : 0;
  }
}
