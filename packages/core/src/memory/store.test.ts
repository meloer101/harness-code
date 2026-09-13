import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MAX_MEMORY_FILE_BYTES } from '../context/memory.js';
import {
  assertSafeMemoryPath,
  discoverMemory,
  loadMemoryIndex,
  parseMemoryFile,
  parseMemoryIndex,
  readMemoryFile,
  rebuildMemoryIndex,
  serializeMemoryEntry,
  writeMemoryFile,
} from './store.js';

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), 'hc-mem-')));
  tmpDirs.push(d);
  return d;
}

function entryMd(over: { name?: string; description?: string; type?: string; body?: string } = {}): string {
  const name = over.name ?? 'testing-no-mocks';
  const description = over.description ?? 'do not mock the database';
  const type = over.type ?? 'feedback';
  const body = over.body ?? 'Use a real test database.\n\n**Why:** mock/prod drift.\n';
  return serializeMemoryEntry({ name, description, type: type as 'feedback', body });
}

describe('assertSafeMemoryPath', () => {
  it('accepts a type/slug.md path', () => {
    expect(assertSafeMemoryPath('feedback/testing-no-mocks.md')).toBe('feedback/testing-no-mocks.md');
  });

  it('rejects traversal, absolute paths, and MEMORY.md', () => {
    expect(() => assertSafeMemoryPath('../secret.md')).toThrow(/invalid/);
    expect(() => assertSafeMemoryPath('/etc/passwd.md')).toThrow(/invalid/);
    expect(() => assertSafeMemoryPath('MEMORY.md')).toThrow(/invalid/);
    expect(() => assertSafeMemoryPath('feedback/foo.txt')).toThrow(/must end with \.md/);
  });
});

describe('parseMemoryIndex', () => {
  it('parses well-formed index lines and skips junk without throwing', () => {
    const { lines, skipped } = parseMemoryIndex(`
# Memory

- [Testing: no mocks](feedback/testing-no-mocks.md) — no mock db
- not a real line
- [Broken](../escape.md) — nope
- [Bug tracker](reference/bug-tracker.md) - pipeline bugs go to Linear
`);
    expect(lines.map((l) => l.path)).toEqual([
      'feedback/testing-no-mocks.md',
      'reference/bug-tracker.md',
    ]);
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    expect(skipped.some((s) => s.includes('Broken'))).toBe(true);
  });
});

describe('parseMemoryFile', () => {
  it('reads type from metadata and description from frontmatter', () => {
    const r = parseMemoryFile(entryMd(), 'feedback/testing-no-mocks.md');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.type).toBe('feedback');
      expect(r.entry.name).toBe('testing-no-mocks');
      expect(r.entry.description).toBe('do not mock the database');
      expect(r.entry.body).toContain('real test database');
    }
  });

  it('skips a file with no description', () => {
    const raw = '---\nname: x\nmetadata:\n  type: feedback\n---\n\nbody\n';
    const r = parseMemoryFile(raw, 'feedback/x.md');
    expect(r.ok).toBe(false);
  });
});

describe('readMemoryFile truncation', () => {
  it('truncates a file over MAX_MEMORY_FILE_BYTES', async () => {
    const root = await tmp();
    const rel = 'feedback/huge.md';
    const abs = join(root, 'feedback');
    await mkdir(abs, { recursive: true });
    const huge = 'x'.repeat(MAX_MEMORY_FILE_BYTES + 50);
    await writeFile(join(abs, 'huge.md'), huge, 'utf8');
    const raw = await readMemoryFile(root, rel);
    expect(raw).toBeDefined();
    expect(raw!).toContain('truncated');
    expect(Buffer.byteLength(raw!, 'utf8')).toBeLessThan(MAX_MEMORY_FILE_BYTES + 200);
  });
});

describe('discoverMemory', () => {
  it('merges project over global over builtin for the same path', async () => {
    const project = await tmp();
    await mkdir(join(project, '.git'), { recursive: true });
    const home = await tmp();
    const builtin = await tmp();

    await writeMemoryFile(join(project, '.agent', 'memory'), 'domain/coding.md', {
      name: 'coding',
      description: 'from project',
      type: 'domain',
      body: 'project body',
    });
    await writeMemoryFile(join(home, '.agent', 'memory'), 'domain/coding.md', {
      name: 'coding',
      description: 'from global',
      type: 'domain',
      body: 'global body',
    });
    await writeMemoryFile(builtin, 'domain/coding.md', {
      name: 'coding',
      description: 'from builtin',
      type: 'domain',
      body: 'builtin body',
    });
    await writeMemoryFile(join(home, '.agent', 'memory'), 'user/role.md', {
      name: 'role',
      description: 'the person',
      type: 'user',
      body: 'a typescript engineer',
    });

    const { entries, counts } = await discoverMemory(project, {
      homeDir: home,
      builtinDir: builtin,
    });
    expect(entries.find((e) => e.path === 'domain/coding.md')?.description).toBe('from project');
    expect(entries.find((e) => e.path === 'domain/coding.md')?.scope).toBe('project');
    expect(entries.find((e) => e.path === 'user/role.md')?.scope).toBe('global');
    expect(counts.project).toBe(1);
    expect(counts.global).toBe(1);
    expect(counts.builtin).toBe(0);
  });

  it('loads packaged domain seeds when no user overlay exists', async () => {
    const project = await tmp();
    await mkdir(join(project, '.git'), { recursive: true });
    const home = await tmp();
    const { entries, counts } = await discoverMemory(project, { homeDir: home });
    // Only `writing.md` ships as a builtin seed — a prior `coding.md` seed was
    // removed for duplicating AGENT_CONVENTIONS almost verbatim.
    expect(entries.some((e) => e.path === 'domain/writing.md' && e.source === 'builtin')).toBe(true);
    expect(counts.builtin).toBeGreaterThanOrEqual(1);
  });

  it('skips invalid files and still returns the valid ones', async () => {
    const project = await tmp();
    await mkdir(join(project, '.git'), { recursive: true });
    const home = await tmp();
    const builtin = await tmp();
    await mkdir(join(builtin, 'feedback'), { recursive: true });
    await writeFile(join(builtin, 'feedback', 'bad.md'), 'not frontmatter', 'utf8');
    await writeMemoryFile(builtin, 'feedback/good.md', {
      name: 'good',
      description: 'ok',
      type: 'feedback',
      body: 'yes',
    });
    const skipped: string[] = [];
    const { entries } = await discoverMemory(project, {
      homeDir: home,
      builtinDir: builtin,
      onSkip: (r) => skipped.push(r),
    });
    expect(entries.map((e) => e.path)).toEqual(['feedback/good.md']);
    expect(skipped.length).toBeGreaterThanOrEqual(1);
  });
});

describe('rebuildMemoryIndex', () => {
  it('writes one index line per file and is idempotent', async () => {
    const root = await tmp();
    await writeMemoryFile(root, 'feedback/a.md', {
      name: 'a',
      description: 'alpha',
      type: 'feedback',
      body: 'A',
    });
    await writeMemoryFile(root, 'reference/b.md', {
      name: 'b',
      description: 'bravo',
      type: 'reference',
      body: 'B',
    });
    await rebuildMemoryIndex(root);
    await rebuildMemoryIndex(root);
    const text = await readFile(join(root, 'MEMORY.md'), 'utf8');
    const { lines } = parseMemoryIndex(text);
    expect(lines).toHaveLength(2);
    expect(loadMemoryIndex).toBeTypeOf('function');
    const loaded = await loadMemoryIndex(root);
    expect(loaded.map((l) => l.path).sort()).toEqual(['feedback/a.md', 'reference/b.md']);
  });
});
