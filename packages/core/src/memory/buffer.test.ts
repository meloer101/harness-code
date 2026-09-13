import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SessionState } from '../agent/session.js';
import { MemoryWriteBuffer } from './buffer.js';
import { createMemoryTool } from './memory-tool.js';
import { parseMemoryIndex, writeMemoryFile } from './store.js';
import type { MemoryEntry } from './types.js';

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function roots(): Promise<{ global: string; project: string; builtin: string }> {
  const global = await realpath(await mkdtemp(join(tmpdir(), 'hc-mglob-')));
  const project = await realpath(await mkdtemp(join(tmpdir(), 'hc-mproj-')));
  const builtin = await realpath(await mkdtemp(join(tmpdir(), 'hc-mbuilt-')));
  tmpDirs.push(global, project, builtin);
  await mkdir(global, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(builtin, { recursive: true });
  return { global, project, builtin };
}

function ctx() {
  return { cwd: '/w', session: new SessionState() };
}

const sample = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  scope: 'project',
  type: 'feedback',
  path: 'feedback/testing-no-mocks.md',
  name: 'testing-no-mocks',
  description: 'no mock db',
  body: 'Use a real test database.',
  source: 'project',
  ...over,
});

describe('MemoryWriteBuffer', () => {
  it('serves a staged write from read without flushing', async () => {
    const r = await roots();
    const buf = new MemoryWriteBuffer(r);
    buf.stage({ kind: 'write', scope: 'project', path: sample().path, entry: sample() });
    const got = await buf.read('project', sample().path);
    expect(got?.body).toContain('real test database');
    await expect(readFile(join(r.project, sample().path), 'utf8')).rejects.toThrow();
  });

  it('flush writes files, rebuilds MEMORY.md, and is idempotent', async () => {
    const r = await roots();
    const buf = new MemoryWriteBuffer(r);
    buf.stage({ kind: 'write', scope: 'project', path: sample().path, entry: sample() });
    buf.stage({
      kind: 'write',
      scope: 'global',
      path: 'user/role.md',
      entry: sample({
        scope: 'global',
        type: 'user',
        path: 'user/role.md',
        name: 'role',
        description: 'the person',
        body: 'senior ts',
        source: 'global',
      }),
    });
    const first = await buf.flush();
    expect(first.written).toHaveLength(2);
    const second = await buf.flush();
    expect(second.written).toEqual([]);
    const index = await readFile(join(r.project, 'MEMORY.md'), 'utf8');
    const { lines } = parseMemoryIndex(index);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.path).toBe(sample().path);
  });

  it('a failing op does not discard the ops that already succeeded or the ones after it', async () => {
    const r = await roots();
    const buf = new MemoryWriteBuffer(r);
    // A plain file at feedback/blocked blocks
    // `mkdir('.../feedback/blocked', { recursive: true })` with ENOTDIR, so the
    // second staged write fails while the first and third are unrelated paths.
    await mkdir(join(r.project, 'feedback'), { recursive: true });
    await writeFile(join(r.project, 'feedback', 'blocked'), 'not a directory');

    buf.stage({ kind: 'write', scope: 'project', path: sample().path, entry: sample() });
    buf.stage({
      kind: 'write',
      scope: 'project',
      path: 'feedback/blocked/note.md',
      entry: sample({ path: 'feedback/blocked/note.md', name: 'note' }),
    });
    buf.stage({
      kind: 'write',
      scope: 'project',
      path: 'feedback/third.md',
      entry: sample({ path: 'feedback/third.md', name: 'third' }),
    });

    await expect(buf.flush()).rejects.toThrow();

    // The op before the failure landed on disk...
    await expect(readFile(join(r.project, sample().path), 'utf8')).resolves.toContain(
      'real test database',
    );
    // ...but the failing op and the one queued after it are still staged, not lost.
    expect(buf.pendingCount).toBe(2);

    // Unblock and retry: a later flush() picks up exactly what is left.
    await rm(join(r.project, 'feedback', 'blocked'));
    const second = await buf.flush();
    expect(second.written.sort()).toEqual([
      'project:feedback/blocked/note.md',
      'project:feedback/third.md',
    ]);
    expect(buf.pendingCount).toBe(0);

    const listed = await buf.list('project');
    expect(listed.map((e) => e.path).sort()).toEqual([
      'feedback/blocked/note.md',
      'feedback/testing-no-mocks.md',
      'feedback/third.md',
    ]);
  });

  it('mixed write and forget leave the filesystem matching the buffer', async () => {
    const r = await roots();
    await writeMemoryFile(r.project, 'feedback/old.md', {
      name: 'old',
      description: 'stale',
      type: 'feedback',
      body: 'old',
    });
    const buf = new MemoryWriteBuffer(r);
    buf.stage({ kind: 'write', scope: 'project', path: sample().path, entry: sample() });
    buf.stage({ kind: 'forget', scope: 'project', path: 'feedback/old.md' });
    await buf.flush();
    const listed = await buf.list('project');
    expect(listed.map((e) => e.path)).toEqual([sample().path]);
  });
});

describe('memory tool', () => {
  it('is read-only and concurrency-safe', async () => {
    const tool = createMemoryTool(new MemoryWriteBuffer(await roots()));
    expect(tool.readOnly).toBe(true);
    expect(tool.concurrencySafe).toBe(true);
  });

  it('reads a disk entry and errors with the available list on unknown path', async () => {
    const r = await roots();
    await writeMemoryFile(r.project, sample().path, sample());
    const tool = createMemoryTool(new MemoryWriteBuffer(r));
    const ok = await tool.execute({ action: 'read', scope: 'project', path: sample().path }, ctx());
    expect(ok.isError).toBeFalsy();
    expect(ok.content).toContain('real test database');

    const miss = await tool.execute(
      { action: 'read', scope: 'project', path: 'feedback/missing.md' },
      ctx(),
    );
    expect(miss.isError).toBe(true);
    expect(miss.content).toContain(sample().path);
  });

  it('write requires type, description, and body', async () => {
    const tool = createMemoryTool(new MemoryWriteBuffer(await roots()));
    const res = await tool.execute(
      { action: 'write', scope: 'project', path: sample().path },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/type|description|body/);
  });

  it('write then read in the same session hits the buffer', async () => {
    const tool = createMemoryTool(new MemoryWriteBuffer(await roots()));
    const written = await tool.execute(
      {
        action: 'write',
        scope: 'project',
        path: sample().path,
        type: 'feedback',
        description: 'no mock db',
        body: 'Use a real test database.',
      },
      ctx(),
    );
    expect(written.isError).toBeFalsy();
    const read = await tool.execute(
      { action: 'read', scope: 'project', path: sample().path },
      ctx(),
    );
    expect(read.content).toContain('Use a real test database.');
  });

  it('forget removes the path from a subsequent list', async () => {
    const r = await roots();
    await writeMemoryFile(r.project, sample().path, sample());
    const buf = new MemoryWriteBuffer(r);
    const tool = createMemoryTool(buf);
    await tool.execute({ action: 'forget', scope: 'project', path: sample().path }, ctx());
    const listed = await tool.execute({ action: 'list', scope: 'project' }, ctx());
    expect(listed.content).toContain('no memory entries');
  });

  it('rejects user type on project scope and mismatched path prefix', async () => {
    const tool = createMemoryTool(new MemoryWriteBuffer(await roots()));
    const user = await tool.execute(
      {
        action: 'write',
        scope: 'project',
        path: 'user/role.md',
        type: 'user',
        description: 'x',
        body: 'y',
      },
      ctx(),
    );
    expect(user.isError).toBe(true);
    const prefix = await tool.execute(
      {
        action: 'write',
        scope: 'project',
        path: 'feedback/x.md',
        type: 'reference',
        description: 'x',
        body: 'y',
      },
      ctx(),
    );
    expect(prefix.isError).toBe(true);
  });
});
