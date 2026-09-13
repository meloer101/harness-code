/**
 * Session-scoped write buffer for persistent memory.
 *
 * `write` / `forget` stage here so the `<available_memory>` system segment stays
 * byte-identical for the rest of the session (prompt-cache prefix). `read` /
 * `list` consult the buffer first so a just-written entry is visible before
 * `flush()` at `AgentSession.close()`.
 */

import {
  deleteMemoryFile,
  listMemoryFiles,
  parseMemoryFile,
  readMemoryFile,
  rebuildMemoryIndex,
  serializeMemoryEntry,
  writeMemoryFile,
} from './store.js';
import type { MemoryEntry, MemoryScope, MemorySource } from './types.js';

export type MemoryStageOp =
  | { kind: 'write'; scope: MemoryScope; path: string; entry: MemoryEntry }
  | { kind: 'forget'; scope: MemoryScope; path: string };

export interface MemoryRoots {
  global: string;
  project: string;
  builtin?: string;
}

function keyOf(scope: MemoryScope, path: string): string {
  return `${scope}:${path}`;
}

function sourceForScope(scope: MemoryScope): MemorySource {
  return scope === 'project' ? 'project' : 'global';
}

export class MemoryWriteBuffer {
  readonly #roots: MemoryRoots;
  readonly #pending = new Map<string, MemoryStageOp>();

  constructor(roots: MemoryRoots) {
    this.#roots = roots;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  root(scope: MemoryScope): string {
    return scope === 'global' ? this.#roots.global : this.#roots.project;
  }

  stage(op: MemoryStageOp): void {
    this.#pending.set(keyOf(op.scope, op.path), op);
  }

  /**
   * Full file text (frontmatter + body). Buffer writes win; staged forgets
   * hide the path for this session. Global misses fall back to builtin.
   */
  async readRaw(scope: MemoryScope, path: string): Promise<string | undefined> {
    const op = this.#pending.get(keyOf(scope, path));
    if (op?.kind === 'forget') return undefined;
    if (op?.kind === 'write') return serializeMemoryEntry(op.entry);
    const fromDisk = await readMemoryFile(this.root(scope), path);
    if (fromDisk !== undefined) return fromDisk;
    if (scope === 'global' && this.#roots.builtin) {
      return readMemoryFile(this.#roots.builtin, path);
    }
    return undefined;
  }

  async read(scope: MemoryScope, path: string): Promise<MemoryEntry | undefined> {
    const op = this.#pending.get(keyOf(scope, path));
    if (op?.kind === 'forget') return undefined;
    if (op?.kind === 'write') return op.entry;

    const raw = await this.readRaw(scope, path);
    if (raw === undefined) return undefined;
    const parsed = parseMemoryFile(raw, path);
    if (!parsed.ok) return undefined;
    const source: MemorySource =
      scope === 'project'
        ? 'project'
        : (await readMemoryFile(this.root('global'), path)) !== undefined
          ? 'global'
          : 'builtin';
    return { ...parsed.entry, scope, source };
  }

  async list(scope: MemoryScope): Promise<MemoryEntry[]> {
    const byPath = new Map<string, MemoryEntry>();
    if (scope === 'global' && this.#roots.builtin) {
      await this.#loadRootInto(byPath, this.#roots.builtin, 'global', 'builtin');
    }
    await this.#loadRootInto(byPath, this.root(scope), scope, sourceForScope(scope));

    for (const op of this.#pending.values()) {
      if (op.scope !== scope) continue;
      if (op.kind === 'forget') byPath.delete(op.path);
      else byPath.set(op.path, op.entry);
    }
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Apply every staged op, then rebuild `MEMORY.md` for each affected scope.
   * Safe to call twice: a second call with an empty buffer is a no-op.
   *
   * Each op is removed from the pending map only once it has actually landed
   * on disk — if `writeMemoryFile`/`deleteMemoryFile` throws partway through
   * (e.g. a full disk or a permission error), everything not yet applied stays
   * staged so a later `flush()` call can retry it, instead of being discarded
   * along with the ops that already succeeded.
   */
  async flush(): Promise<{ written: string[]; forgotten: string[] }> {
    const written: string[] = [];
    const forgotten: string[] = [];
    const affected = new Set<MemoryScope>();

    try {
      for (const [key, op] of [...this.#pending.entries()]) {
        const root = this.root(op.scope);
        const label = `${op.scope}:${op.path}`;
        if (op.kind === 'write') {
          await writeMemoryFile(root, op.path, op.entry);
          written.push(label);
        } else {
          await deleteMemoryFile(root, op.path);
          forgotten.push(label);
        }
        this.#pending.delete(key);
        affected.add(op.scope);
      }
    } finally {
      // Rebuild the index for whatever scopes actually changed, even if a
      // later op in the batch failed — the successful writes above should not
      // end up invisible in MEMORY.md just because a sibling op threw.
      for (const scope of affected) {
        await rebuildMemoryIndex(this.root(scope));
      }
    }
    return { written, forgotten };
  }

  async #loadRootInto(
    into: Map<string, MemoryEntry>,
    root: string,
    scope: MemoryScope,
    source: MemorySource,
  ): Promise<void> {
    for (const path of await listMemoryFiles(root)) {
      const raw = await readMemoryFile(root, path);
      if (raw === undefined) continue;
      const parsed = parseMemoryFile(raw, path);
      if (!parsed.ok) continue;
      into.set(path, { ...parsed.entry, scope, source });
    }
  }
}
