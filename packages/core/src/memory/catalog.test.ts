import { describe, expect, it } from 'vitest';

import { heuristicTokenCount } from '../context/tokenizer.js';
import { emptyMemoryManifest, MAX_MEMORY_MANIFEST_TOKENS, MemoryCatalog } from './catalog.js';
import type { MemoryEntry } from './types.js';

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  scope: 'global',
  type: 'feedback',
  path: over.path ?? `feedback/${over.name ?? 'note'}.md`,
  name: over.name ?? 'note',
  description: over.description ?? 'a standing note',
  body: 'body',
  source: 'global',
  ...over,
});

describe('MemoryCatalog', () => {
  it('builds a manifest listing path, type, scope, and description', () => {
    const cat = new MemoryCatalog([
      entry({ path: 'user/role.md', type: 'user', name: 'role', description: 'the person' }),
      entry({
        path: 'feedback/testing-no-mocks.md',
        name: 'testing-no-mocks',
        description: 'no mock db',
      }),
    ]);
    const m = cat.manifest()!;
    expect(m).toContain('<available_memory>');
    expect(m).toContain('- user/role.md [user, global]: the person');
    expect(m).toContain('- feedback/testing-no-mocks.md [feedback, global]: no mock db');
    expect(cat.get('user/role.md')?.name).toBe('role');
  });

  it('returns no manifest when empty, while emptyMemoryManifest still carries write policy', () => {
    expect(new MemoryCatalog([]).manifest()).toBeUndefined();
    expect(new MemoryCatalog([]).manifestTokens()).toBe(0);
    expect(emptyMemoryManifest()).toContain('<available_memory>');
    expect(emptyMemoryManifest()).toMatch(/future session/i);
  });

  it('keeps the manifest under the token ceiling, dropping the overflow', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      entry({
        path: `feedback/note-${i}.md`,
        name: `note-${i}`,
        description: 'a fairly wordy description '.repeat(6),
      }),
    );
    const cat = new MemoryCatalog(many);
    expect(cat.manifestTokens(heuristicTokenCount)).toBeLessThanOrEqual(MAX_MEMORY_MANIFEST_TOKENS);
    expect(cat.advertised.length).toBeGreaterThan(0);
    expect(cat.dropped.length).toBeGreaterThan(0);
    expect(cat.advertised.length + cat.dropped.length).toBe(200);
    expect(cat.get(cat.dropped[0]!)).toBeDefined();
  });

  it('lets a later constructor entry with the same path be ignored (caller already shadowed)', () => {
    const cat = new MemoryCatalog([
      entry({
        path: 'domain/coding.md',
        type: 'domain',
        scope: 'project',
        source: 'project',
        description: 'project coding',
      }),
      entry({
        path: 'domain/coding.md',
        type: 'domain',
        scope: 'global',
        source: 'global',
        description: 'global coding',
      }),
    ]);
    expect(cat.size).toBe(1);
    expect(cat.get('domain/coding.md')?.description).toBe('project coding');
    expect(cat.manifest()).toContain('[domain, project]');
  });
});
