import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mergeSettings } from '../config/settings.js';
import { createPermissionEngine } from './engine.js';
import { createPermissionHooks, nonInteractiveAskHandler } from './hooks.js';
import type { PermissionEngine } from './engine.js';

describe('PermissionEngine', () => {
  let root: string;
  let engine: (overrides?: Partial<Parameters<typeof createPermissionEngine>[0]>) => PermissionEngine;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hc-eng-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'ok', 'utf8');
    await writeFile(join(root, '.env'), 'SECRET=1', 'utf8');
    engine = (overrides = {}) =>
      createPermissionEngine({
        workspaceRoot: root,
        mode: 'ask',
        allow: [],
        ask: [],
        deny: [],
        ...overrides,
      });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lets deny beat allow', async () => {
    const e = engine({
      allow: ['Read'],
      deny: ['Read(./src/**)'],
    });
    const v = await e.evaluate({ toolName: 'read', input: { path: 'src/a.ts' }, readOnly: true });
    expect(v.decision).toBe('deny');
  });

  it('lets a specific allow cover a sensitive file, but not a path-cage escape', async () => {
    const e = engine({
      mode: 'yolo',
      allow: ['Read(.env)', 'Read(.env.*)'],
    });
    const env = await e.evaluate({ toolName: 'read', input: { path: '.env' }, readOnly: true });
    expect(env.decision).toBe('allow');

    const escape = await e.evaluate({
      toolName: 'read',
      input: { path: '../secret' },
      readOnly: true,
    });
    expect(escape.decision).toBe('deny');
    if (escape.decision === 'deny') expect(escape.reason).toMatch(/escapes the workspace/);
  });

  it('does not let a bare Read allow override .env', async () => {
    const e = engine({ allow: ['Read'] });
    const v = await e.evaluate({ toolName: 'read', input: { path: '.env' }, readOnly: true });
    expect(v.decision).toBe('deny');
    if (v.decision === 'deny') expect(v.reason).toMatch(/sensitive/);
  });

  it('readOnly mode denies write and bash, allows read and todo', async () => {
    const e = engine({ mode: 'readOnly' });
    expect(
      (await e.evaluate({ toolName: 'write', input: { path: 'src/a.ts', content: 'x' }, readOnly: false }))
        .decision,
    ).toBe('deny');
    expect(
      (await e.evaluate({ toolName: 'bash', input: { command: 'echo hi' }, readOnly: false })).decision,
    ).toBe('deny');
    expect(
      (await e.evaluate({ toolName: 'read', input: { path: 'src/a.ts' }, readOnly: true })).decision,
    ).toBe('allow');
    expect((await e.evaluate({ toolName: 'todo', input: { todos: [] }, readOnly: false })).decision).toBe(
      'allow',
    );
  });

  it('acceptEdits allows write but asks for bash', async () => {
    const e = engine({ mode: 'acceptEdits' });
    expect(
      (await e.evaluate({ toolName: 'write', input: { path: 'new.txt', content: 'x' }, readOnly: false }))
        .decision,
    ).toBe('allow');
    expect(
      (await e.evaluate({ toolName: 'bash', input: { command: 'echo hi' }, readOnly: false })).decision,
    ).toBe('ask');
  });

  it('plan mode denies write', async () => {
    const e = engine({ mode: 'plan' });
    const v = await e.evaluate({
      toolName: 'write',
      input: { path: 'src/a.ts', content: 'x' },
      readOnly: false,
    });
    expect(v.decision).toBe('deny');
    if (v.decision === 'deny') expect(v.reason).toMatch(/plan mode/);
  });

  it('plan mode lets write/edit through only for .agent/plans/', async () => {
    const e = engine({ mode: 'plan' });
    const inside = await e.evaluate({
      toolName: 'write',
      input: { path: '.agent/plans/20260906-1200-x.md', content: '# plan' },
      readOnly: false,
    });
    expect(inside.decision).toBe('allow');

    const elsewhereAgent = await e.evaluate({
      toolName: 'write',
      input: { path: '.agent/settings.json', content: '{}' },
      readOnly: false,
    });
    expect(elsewhereAgent.decision).toBe('deny');
  });

  it('plan mode allows exit_plan_mode; a deny rule still wins', async () => {
    const ok = await engine({ mode: 'plan' }).evaluate({
      toolName: 'exit_plan_mode',
      input: { plan: '...' },
      readOnly: false,
    });
    expect(ok.decision).toBe('allow');

    const blocked = await engine({ mode: 'plan', deny: ['exit_plan_mode'] }).evaluate({
      toolName: 'exit_plan_mode',
      input: { plan: '...' },
      readOnly: false,
    });
    expect(blocked.decision).toBe('deny');
  });

  it('exit_plan_mode is a known tool (not rejected as unknown)', async () => {
    const v = await engine({ mode: 'ask' }).evaluate({
      toolName: 'exit_plan_mode',
      input: {},
      readOnly: false,
    });
    expect(v.decision).not.toBe('deny');
  });

  it('addAllowRule whitelists a whole tool for the rest of the session', async () => {
    const e = engine({ mode: 'ask' });
    expect((await e.evaluate({ toolName: 'bash', input: { command: 'npm test' }, readOnly: false })).decision).toBe(
      'ask',
    );
    e.addAllowRule('Bash');
    expect((await e.evaluate({ toolName: 'bash', input: { command: 'npm test' }, readOnly: false })).decision).toBe(
      'allow',
    );
    expect((await e.evaluate({ toolName: 'bash', input: { command: 'git push' }, readOnly: false })).decision).toBe(
      'allow',
    );
  });

  it('a runtime allow rule does not defeat sensitive-file protection', async () => {
    const e = engine({ mode: 'ask' });
    e.addAllowRule('Read');
    const v = await e.evaluate({ toolName: 'read', input: { path: '.env' }, readOnly: true });
    expect(v.decision).toBe('deny');
  });

  it('setMode changes later verdicts', async () => {
    const e = engine({ mode: 'plan' });
    expect(e.getMode()).toBe('plan');
    expect(
      (await e.evaluate({ toolName: 'write', input: { path: 'a.txt', content: 'x' }, readOnly: false })).decision,
    ).toBe('deny');
    e.setMode('acceptEdits');
    expect(
      (await e.evaluate({ toolName: 'write', input: { path: 'a.txt', content: 'x' }, readOnly: false })).decision,
    ).toBe('allow');
  });

  it('once addAllowRule fires, the hook stops asking for that tool', async () => {
    const e = engine({ mode: 'ask' });
    let asks = 0;
    const hooks = createPermissionHooks(e, async ({ toolName }) => {
      asks++;
      e.addAllowRule(toolName);
      return { decision: 'allow' };
    });
    const call = { type: 'tool_use' as const, id: '1', name: 'bash', input: { command: 'ls' } };
    await hooks.onBeforeToolCall!(call, { turn: 1, cwd: root });
    await hooks.onBeforeToolCall!(call, { turn: 2, cwd: root });
    expect(asks).toBe(1);
  });

  it('yolo still hard-denies rm -rf /', async () => {
    const e = engine({ mode: 'yolo' });
    const v = await e.evaluate({
      toolName: 'bash',
      input: { command: 'rm -rf /' },
      readOnly: false,
    });
    expect(v.decision).toBe('deny');
  });

  it('denies unknown tools', async () => {
    const e = engine({ mode: 'yolo' });
    const v = await e.evaluate({ toolName: 'danger', input: {}, readOnly: false });
    expect(v.decision).toBe('deny');
    if (v.decision === 'deny') expect(v.reason).toMatch(/unknown tool/i);
  });
});

describe('mergeSettings permissions', () => {
  it('concatenates allow/ask/deny and lets the project override mode', () => {
    const merged = mergeSettings(
      { permissions: { mode: 'ask', allow: ['Read'], ask: [], deny: ['Bash(rm *:*)'] } },
      { permissions: { mode: 'yolo', allow: ['Glob'], deny: ['Write(./secrets/**)'] } },
    );
    expect(merged.permissions?.mode).toBe('yolo');
    expect(merged.permissions?.allow).toEqual(['Read', 'Glob']);
    expect(merged.permissions?.deny).toEqual(['Bash(rm *:*)', 'Write(./secrets/**)']);
  });
});

describe('createPermissionHooks', () => {
  it('turns ask into deny via the non-interactive handler', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hc-hook-'));
    try {
      const engine = createPermissionEngine({
        workspaceRoot: root,
        mode: 'ask',
        allow: [],
        ask: [],
        deny: [],
      });
      const hooks = createPermissionHooks(engine, nonInteractiveAskHandler);
      const decision = await hooks.onBeforeToolCall?.(
        { type: 'tool_use', id: '1', name: 'bash', input: { command: 'echo hi' } },
        { turn: 1, cwd: root },
      );
      expect(decision).toMatchObject({ decision: 'deny' });
      if (decision && decision.decision === 'deny') {
        expect(decision.reason).toMatch(/non-interactive/i);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
