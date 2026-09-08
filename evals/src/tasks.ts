/**
 * Task discovery. A task is a directory under `evals/tasks/<id>/` holding:
 *
 *   task.json      metadata (id, prompt, model, mode, tags, runs, expectRefusal)
 *   fixture/       files copied verbatim into a fresh workspace before the run
 *   assert.mjs     run with cwd = the post-run workspace; exit 0 = pass
 *   cassette.jsonl recorded model exchanges (committed; replayed in CI)
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PermissionMode } from '@harness-code/core';

export interface TaskSpec {
  id: string;
  prompt: string;
  /** `provider/model`. */
  model: string;
  mode: PermissionMode;
  tags: string[];
  /** How many times the runner executes this task. */
  runs: number;
  /** A correct outcome is the agent declining — a forbidden action never lands. */
  expectRefusal?: boolean;
  /** Extra permission rules for this task. */
  allow?: string[];
  deny?: string[];
  /** Cap on agent turns for this task (harness default 30). */
  maxTurns?: number;
}

export interface Task {
  spec: TaskSpec;
  dir: string;
  fixtureDir: string;
  assertPath: string;
  cassettePath: string;
}

/** `<repo>/evals` — this file is `evals/dist/tasks.js` at runtime, `evals/src/tasks.ts` under vitest. */
export function evalsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ or src/ -> parent is evals/
  return join(here, '..');
}

export function tasksDir(): string {
  return join(evalsRoot(), 'tasks');
}

const REQUIRED_MODES: PermissionMode[] = ['ask', 'plan', 'acceptEdits', 'readOnly', 'yolo'];

function validate(raw: unknown, id: string): TaskSpec {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${id}/task.json is not an object`);
  const r = raw as Record<string, unknown>;
  if (r.id !== id) throw new Error(`${id}/task.json: "id" is "${String(r.id)}", must equal the directory name`);
  if (typeof r.prompt !== 'string' || r.prompt.trim() === '') throw new Error(`${id}/task.json: "prompt" missing`);
  if (typeof r.model !== 'string') throw new Error(`${id}/task.json: "model" missing`);
  if (!REQUIRED_MODES.includes(r.mode as PermissionMode)) {
    throw new Error(`${id}/task.json: "mode" must be one of ${REQUIRED_MODES.join(', ')}`);
  }
  return {
    id,
    prompt: r.prompt,
    model: r.model,
    mode: r.mode as PermissionMode,
    tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
    runs: typeof r.runs === 'number' && r.runs > 0 ? Math.floor(r.runs) : 3,
    ...(r.expectRefusal === true ? { expectRefusal: true } : {}),
    ...(Array.isArray(r.allow) ? { allow: r.allow.map(String) } : {}),
    ...(Array.isArray(r.deny) ? { deny: r.deny.map(String) } : {}),
    ...(typeof r.maxTurns === 'number' ? { maxTurns: Math.floor(r.maxTurns) } : {}),
  };
}

export async function loadTasks(only?: string[]): Promise<Task[]> {
  const root = tasksDir();
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    throw new Error(`no tasks directory at ${root}`);
  }
  const wanted = only && only.length > 0 ? new Set(only) : undefined;

  const tasks: Task[] = [];
  for (const id of names) {
    if (wanted && !wanted.has(id)) continue;
    const dir = join(root, id);
    const spec = validate(JSON.parse(await readFile(join(dir, 'task.json'), 'utf8')), id);
    tasks.push({
      spec,
      dir,
      fixtureDir: join(dir, 'fixture'),
      assertPath: join(dir, 'assert.mjs'),
      cassettePath: join(dir, 'cassette.jsonl'),
    });
  }
  if (wanted) {
    for (const id of wanted) {
      if (!tasks.some((t) => t.spec.id === id)) throw new Error(`no task "${id}" under ${root}`);
    }
  }
  return tasks;
}
