/**
 * Persistent cross-session memory — types.
 *
 * Distinct from `context/memory.ts` (static AGENTS.md / CLAUDE.md). A memory
 * entry's `scope` is implied by the directory it lives in; `type` is recorded
 * in frontmatter and used for the manifest tag and write-time validation.
 */

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference', 'domain'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_SCOPES = ['global', 'project'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_SOURCES = ['project', 'global', 'builtin'] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export function isMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value);
}

export function isMemoryScope(value: string): value is MemoryScope {
  return (MEMORY_SCOPES as readonly string[]).includes(value);
}

export interface MemoryEntry {
  /** Directory the file lives in. Builtin entries are scoped `global`. */
  scope: MemoryScope;
  type: MemoryType;
  /** Posix relative path from the memory root, e.g. `feedback/testing-no-mocks.md`. */
  path: string;
  name: string;
  description: string;
  body: string;
  source: MemorySource;
}

/** ~150-character ceiling for one `MEMORY.md` index line, matching the host's own index rule. */
export const MAX_INDEX_LINE_CHARS = 150;
