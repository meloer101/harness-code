/**
 * On-disk memory store: one directory tree per scope, plus packaged builtins.
 *
 *   ~/.agent/memory/                 global
 *   <projectRoot>/.agent/memory/     project
 *   packages/core/memory/            builtin (lowest precedence)
 *
 * `MEMORY.md` is a human-readable index; the catalog is built by scanning
 * `.md` files so a missing index line does not hide an entry. Invalid files
 * and unparseable index lines are skipped with `onSkip`, never fatal.
 */

import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';
import { stringify as yamlStringify } from 'yaml';

import { AGENT_DIR, findProjectRoot } from '../config/settings.js';
import { MAX_MEMORY_FILE_BYTES } from '../context/memory.js';
import {
  isMemoryType,
  MAX_INDEX_LINE_CHARS,
  type MemoryEntry,
  type MemoryScope,
  type MemorySource,
  type MemoryType,
} from './types.js';

export const MEMORY_DIR = 'memory';
export const MEMORY_INDEX = 'MEMORY.md';

/** `packages/core/memory/`, resolved relative to this module (src and dist alike). */
export function builtinMemoryDir(): string {
  return fileURLToPath(new URL('../../memory/', import.meta.url));
}

export interface MemoryIndexLine {
  title: string;
  path: string;
  description: string;
}

export interface ParseMemoryIndexResult {
  lines: MemoryIndexLine[];
  skipped: string[];
}

const INDEX_LINE_RE = /^- \[([^\]]+)\]\(([^)]+)\)\s+[—\-]\s+(.*)$/;

export function parseMemoryIndex(text: string): ParseMemoryIndexResult {
  const lines: MemoryIndexLine[] = [];
  const skipped: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = INDEX_LINE_RE.exec(line);
    if (!m) {
      if (line.startsWith('- ')) skipped.push(line);
      continue;
    }
    const title = m[1]!.trim();
    const path = m[2]!.trim();
    const description = m[3]!.trim();
    try {
      assertSafeMemoryPath(path);
    } catch {
      skipped.push(line);
      continue;
    }
    lines.push({ title, path, description });
  }
  return { lines, skipped };
}

export async function loadMemoryIndex(
  root: string,
  opts: { onSkip?: (reason: string) => void } = {},
): Promise<MemoryIndexLine[]> {
  let raw: string;
  try {
    raw = await readFile(join(root, MEMORY_INDEX), 'utf8');
  } catch {
    return [];
  }
  const { lines, skipped } = parseMemoryIndex(raw);
  for (const line of skipped) {
    opts.onSkip?.(`index skipped unparseable line: ${line}`);
  }
  return lines;
}

/**
 * Reject absolute paths, `..`, empty segments, and anything that is not a
 * `.md` file under the memory root. Returns the posix-normalized relative path.
 */
export function assertSafeMemoryPath(relPath: string): string {
  const posix = relPath.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!posix || posix.includes('\0')) {
    throw new Error(`invalid memory path "${relPath}"`);
  }
  const parts = posix.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`invalid memory path "${relPath}"`);
  }
  if (isAbsolute(relPath) || posix === MEMORY_INDEX || posix.endsWith(`/${MEMORY_INDEX}`)) {
    throw new Error(`invalid memory path "${relPath}"`);
  }
  if (!posix.endsWith('.md')) {
    throw new Error(`memory path must end with .md: "${relPath}"`);
  }
  return posix;
}

export function safeResolve(root: string, relPath: string): string {
  const posix = assertSafeMemoryPath(relPath);
  const abs = resolve(root, ...posix.split('/'));
  const rel = relative(resolve(root), abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`memory path escapes the store: "${relPath}"`);
  }
  return abs;
}

export function validateScopeType(scope: MemoryScope, type: MemoryType): string | undefined {
  if (type === 'user' && scope !== 'global') {
    return 'type "user" can only be written to global scope';
  }
  if (type === 'project' && scope !== 'project') {
    return 'type "project" can only be written to project scope';
  }
  return undefined;
}

export function validatePathType(path: string, type: MemoryType): string | undefined {
  if (!path.startsWith(`${type}/`)) {
    return `path must start with "${type}/"`;
  }
  return undefined;
}

export async function listMemoryFiles(root: string): Promise<string[]> {
  return walkMd(root, '');
}

async function walkMd(dir: string, prefix: string): Promise<string[]> {
  let ents;
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...(await walkMd(join(dir, e.name), rel)));
    } else if (e.isFile() && e.name.endsWith('.md') && rel !== MEMORY_INDEX) {
      out.push(rel);
    }
  }
  return out;
}

export interface ParsedMemoryFile {
  ok: true;
  entry: Omit<MemoryEntry, 'scope' | 'source'>;
}

export interface InvalidMemoryFile {
  ok: false;
  reason: string;
}

export function parseMemoryFile(
  raw: string,
  path: string,
): ParsedMemoryFile | InvalidMemoryFile {
  let posix: string;
  try {
    posix = assertSafeMemoryPath(path);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  let data: Record<string, unknown>;
  let body: string;
  try {
    const parsed = matter(raw);
    data = parsed.data as Record<string, unknown>;
    body = parsed.content.trim();
  } catch (err) {
    return {
      ok: false,
      reason: `frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const type = typeOf(data, posix);
  if (!type) {
    return { ok: false, reason: 'missing or unknown type (frontmatter metadata.type or path prefix)' };
  }
  const prefixErr = validatePathType(posix, type);
  if (prefixErr) return { ok: false, reason: prefixErr };

  const name =
    typeof data.name === 'string' && data.name.trim() !== ''
      ? data.name.trim()
      : slugFromPath(posix);
  if (name === '') return { ok: false, reason: 'missing name' };

  const description =
    typeof data.description === 'string' && data.description.trim() !== ''
      ? data.description.trim()
      : '';
  if (description === '') {
    return { ok: false, reason: 'frontmatter is missing a non-empty "description"' };
  }

  return { ok: true, entry: { type, path: posix, name, description, body } };
}

function typeOf(data: Record<string, unknown>, path: string): MemoryType | undefined {
  const meta = data.metadata;
  const fromMeta =
    meta && typeof meta === 'object' && !Array.isArray(meta) && 'type' in meta
      ? (meta as { type?: unknown }).type
      : undefined;
  const candidates = [fromMeta, data.type, path.split('/')[0]];
  for (const c of candidates) {
    if (typeof c === 'string' && isMemoryType(c)) return c;
  }
  return undefined;
}

function slugFromPath(path: string): string {
  const base = path.split('/').pop() ?? '';
  return base.replace(/\.md$/i, '');
}

export async function readMemoryFile(
  root: string,
  path: string,
): Promise<string | undefined> {
  let abs: string;
  try {
    abs = safeResolve(root, path);
  } catch {
    return undefined;
  }
  try {
    const raw = await readFile(abs, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_MEMORY_FILE_BYTES) {
      return `${raw.slice(0, MAX_MEMORY_FILE_BYTES)}\n\n[… truncated: file exceeds ${MAX_MEMORY_FILE_BYTES / 1024} KiB]`;
    }
    return raw;
  } catch {
    return undefined;
  }
}

export async function readParsedMemoryFile(
  root: string,
  path: string,
  scope: MemoryScope,
  source: MemorySource,
): Promise<MemoryEntry | undefined> {
  const raw = await readMemoryFile(root, path);
  if (raw === undefined) return undefined;
  const parsed = parseMemoryFile(raw, path);
  if (!parsed.ok) return undefined;
  return { ...parsed.entry, scope, source };
}

export function serializeMemoryEntry(entry: Pick<MemoryEntry, 'name' | 'description' | 'type' | 'body'>): string {
  const fm = yamlStringify({
    name: entry.name,
    description: entry.description,
    metadata: { type: entry.type },
  }).trimEnd();
  return `---\n${fm}\n---\n\n${entry.body.trimEnd()}\n`;
}

export async function writeMemoryFile(
  root: string,
  path: string,
  entry: Pick<MemoryEntry, 'name' | 'description' | 'type' | 'body'>,
): Promise<void> {
  const abs = safeResolve(root, path);
  const serialized = serializeMemoryEntry(entry);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_MEMORY_FILE_BYTES) {
    throw new Error(`memory entry exceeds ${MAX_MEMORY_FILE_BYTES / 1024} KiB`);
  }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, serialized, 'utf8');
}

export async function deleteMemoryFile(root: string, path: string): Promise<void> {
  const abs = safeResolve(root, path);
  try {
    await unlink(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function renderMemoryIndex(entries: readonly Pick<MemoryEntry, 'name' | 'path' | 'description'>[]): string {
  const lines = [...entries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((e) => {
      let line = `- [${e.name}](${e.path}) — ${e.description}`;
      if (line.length > MAX_INDEX_LINE_CHARS) {
        line = `${line.slice(0, MAX_INDEX_LINE_CHARS - 3)}...`;
      }
      return line;
    });
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

export async function rebuildMemoryIndex(root: string): Promise<void> {
  const files = await listMemoryFiles(root);
  const entries: Pick<MemoryEntry, 'name' | 'path' | 'description'>[] = [];
  for (const path of files) {
    const raw = await readMemoryFile(root, path);
    if (raw === undefined) continue;
    const parsed = parseMemoryFile(raw, path);
    if (!parsed.ok) continue;
    entries.push(parsed.entry);
  }
  await mkdir(root, { recursive: true });
  await writeFile(join(root, MEMORY_INDEX), renderMemoryIndex(entries), 'utf8');
}

export interface DiscoverMemoryOptions {
  homeDir?: string;
  builtinDir?: string;
  onSkip?: (reason: string) => void;
}

export interface DiscoveredMemory {
  entries: MemoryEntry[];
  counts: Record<MemorySource, number>;
}

async function loadRoot(
  root: string,
  scope: MemoryScope,
  source: MemorySource,
  onSkip?: (reason: string) => void,
): Promise<MemoryEntry[]> {
  const files = await listMemoryFiles(root);
  const out: MemoryEntry[] = [];
  for (const path of files) {
    const raw = await readMemoryFile(root, path);
    if (raw === undefined) continue;
    const parsed = parseMemoryFile(raw, path);
    if (!parsed.ok) {
      onSkip?.(`${source} ${path}: ${parsed.reason}`);
      continue;
    }
    const scopeErr = validateScopeType(scope, parsed.entry.type);
    if (scopeErr) {
      onSkip?.(`${source} ${path}: ${scopeErr}`);
      continue;
    }
    out.push({ ...parsed.entry, scope, source });
  }
  return out;
}

/**
 * Load project, then global, then builtin. First path wins — project shadows
 * global shadows builtin, matching Skills' project > user > builtin rule.
 */
export async function discoverMemory(
  cwd = process.cwd(),
  opts: DiscoverMemoryOptions = {},
): Promise<DiscoveredMemory> {
  const home = opts.homeDir ?? homedir();
  const projectRoot = await findProjectRoot(cwd);
  const roots: { dir: string; scope: MemoryScope; source: MemorySource }[] = [
    { dir: join(projectRoot, AGENT_DIR, MEMORY_DIR), scope: 'project', source: 'project' },
    { dir: join(home, AGENT_DIR, MEMORY_DIR), scope: 'global', source: 'global' },
    {
      dir: opts.builtinDir ?? builtinMemoryDir(),
      scope: 'global',
      source: 'builtin',
    },
  ];

  const byPath = new Map<string, MemoryEntry>();
  const counts: Record<MemorySource, number> = { project: 0, global: 0, builtin: 0 };

  for (const { dir, scope, source } of roots) {
    const loaded = await loadRoot(dir, scope, source, opts.onSkip);
    for (const entry of loaded) {
      if (byPath.has(entry.path)) continue;
      byPath.set(entry.path, entry);
      counts[source]++;
    }
  }

  return { entries: [...byPath.values()], counts };
}
