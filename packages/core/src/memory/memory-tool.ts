/**
 * The `memory` tool — progressive disclosure tier 2, plus write / forget / list.
 *
 * One tool with an `action` enum rather than four tools (same shape as this
 * host's Artifact-style action tools). Reads consult the session write buffer
 * so a just-written entry is visible before close-time flush. Writes do not
 * touch the workspace; they stage metadata the agent is accumulating about
 * the user / project / collaboration style.
 */

import { z } from 'zod';

import type { ToolSpec } from '../tools/types.js';
import { MAX_MEMORY_FILE_BYTES } from '../context/memory.js';
import type { MemoryWriteBuffer } from './buffer.js';
import { assertSafeMemoryPath, serializeMemoryEntry, validatePathType, validateScopeType } from './store.js';
import { MEMORY_SCOPES, MEMORY_TYPES, type MemoryEntry, type MemoryType } from './types.js';

const schema = z.object({
  action: z
    .enum(['read', 'write', 'forget', 'list'])
    .describe('read a note, write/update one, forget one, or list a scope'),
  scope: z
    .enum(MEMORY_SCOPES)
    .describe('global (~/.agent/memory) or project (<root>/.agent/memory)'),
  path: z
    .string()
    .optional()
    .describe('Relative path, e.g. "feedback/testing-no-mocks.md". Required for read/write/forget.'),
  type: z
    .enum(MEMORY_TYPES)
    .optional()
    .describe('Entry type. Required for write. Must match the path prefix (feedback/…, domain/…).'),
  description: z
    .string()
    .optional()
    .describe('One-line hook for the index / manifest. Required for write.'),
  body: z.string().optional().describe('Markdown body. Required for write.'),
});

export type MemoryToolInput = z.infer<typeof schema>;

function formatEntry(entry: MemoryEntry): string {
  return (
    `[${entry.type}, ${entry.scope}] ${entry.path} — ${entry.description}\n\n` + `${entry.body}`
  );
}

function availableList(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return '(none)';
  return entries.map((e) => `${e.path} [${e.type}, ${e.scope}]`).join(', ');
}

export function createMemoryTool(buffer: MemoryWriteBuffer): ToolSpec<MemoryToolInput> {
  return {
    name: 'memory',
    description:
      'Read, write, forget, or list persistent notes that survive across sessions ' +
      '(see <available_memory>). Write when you learn something that will matter later ' +
      'and is not already in the code, git history, or AGENTS.md. Update an existing ' +
      'entry instead of creating a near-duplicate.',
    schema,
    readOnly: true,
    concurrencySafe: true,
    async execute(input) {
      if (input.action === 'list') {
        const entries = await buffer.list(input.scope);
        if (entries.length === 0) {
          return { content: `(no memory entries in ${input.scope} scope)` };
        }
        const lines = entries.map(
          (e) => `- ${e.path} [${e.type}, ${e.scope}]: ${e.description}`,
        );
        return { content: `${entries.length} in ${input.scope}:\n${lines.join('\n')}` };
      }

      if (!input.path || input.path.trim() === '') {
        return { content: `path is required for action "${input.action}"`, isError: true };
      }
      const path = input.path.trim();

      if (input.action === 'read') {
        const entry = await buffer.read(input.scope, path);
        if (!entry) {
          const known = availableList(await buffer.list(input.scope));
          return {
            content: `No memory entry at ${input.scope}:${path}. Available: ${known}.`,
            isError: true,
          };
        }
        return { content: formatEntry(entry) };
      }

      if (input.action === 'forget') {
        buffer.stage({ kind: 'forget', scope: input.scope, path });
        return { content: `Forgot ${input.scope}:${path} (will persist when this session ends).` };
      }

      // write
      if (!input.type) {
        return { content: 'write requires type', isError: true };
      }
      if (!input.description || input.description.trim() === '') {
        return { content: 'write requires description', isError: true };
      }
      if (input.body === undefined) {
        return { content: 'write requires body', isError: true };
      }
      const type = input.type as MemoryType;
      const scopeErr = validateScopeType(input.scope, type);
      if (scopeErr) return { content: scopeErr, isError: true };
      const pathErr = validatePathType(path, type);
      if (pathErr) return { content: pathErr, isError: true };

      let safePath: string;
      try {
        safePath = assertSafeMemoryPath(path);
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }

      const name = safePath.split('/').pop()!.replace(/\.md$/i, '');
      const entry: MemoryEntry = {
        scope: input.scope,
        type,
        path: safePath,
        name,
        description: input.description.trim(),
        body: input.body,
        source: input.scope === 'project' ? 'project' : 'global',
      };
      const serialized = serializeMemoryEntry(entry);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_MEMORY_FILE_BYTES) {
        return {
          content: `memory entry exceeds ${MAX_MEMORY_FILE_BYTES / 1024} KiB`,
          isError: true,
        };
      }
      buffer.stage({ kind: 'write', scope: input.scope, path: safePath, entry });
      return {
        content: `Wrote ${input.scope}:${safePath} (will persist when this session ends).`,
      };
    },
  };
}
