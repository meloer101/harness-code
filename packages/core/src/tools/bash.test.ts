import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionState } from '../agent/session.js';
import { bashTool } from './bash.js';
import type { ToolContext } from './types.js';

describe('bashTool', () => {
  let cwd: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    // realpath: os.tmpdir() is a symlink on macOS; assertInsideWorkspace()
    // realpaths everything, so `cwd` needs to be canonical too.
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'hc-bash-')));
    ctx = { cwd, session: new SessionState() };
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('returns stdout on success', async () => {
    const result = await bashTool.execute({ command: 'echo hello' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content.trim()).toBe('hello');
  });

  it('can still write inside the workspace, whether or not the OS sandbox is active', async () => {
    // On macOS this runs through wrapCommand()'s sandbox-exec path (see
    // macos-sandbox.test.ts); on any other platform — including this
    // project's ubuntu-latest CI — sandbox-exec isn't available and it
    // falls back to a plain spawn. Either way, a write inside the workspace
    // must succeed: the whole point of the profile is to scope writes to
    // this directory, not to block them here too.
    const { readFile } = await import('node:fs/promises');
    const result = await bashTool.execute({ command: 'echo hello > out.txt' }, ctx);
    expect(result.isError).toBeUndefined();
    expect((await readFile(join(cwd, 'out.txt'), 'utf8')).trim()).toBe('hello');
  });

  it('reports a non-zero exit code as an error', async () => {
    const result = await bashTool.execute({ command: 'exit 3' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('exit code 3');
  });

  it('kills a command that exceeds the timeout', async () => {
    const result = await bashTool.execute({ command: 'sleep 5', timeoutMs: 100 }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out');
  }, 10_000);

  it('truncates very large output and reports how much was omitted', async () => {
    const result = await bashTool.execute(
      { command: 'node -e "process.stdout.write(\'x\'.repeat(50000))"' },
      ctx,
    );
    expect(result.content).toMatch(/characters.*omitted/);
    expect(result.content.length).toBeLessThan(50_000);
  });

  it('refuses a cwd outside the workspace without spawning', async () => {
    const result = await bashTool.execute({ command: 'echo pwned', cwd: '..' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/escapes the workspace/);
  });

  it('does not leak API keys into the child environment', async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-should-not-leak';
    try {
      const result = await bashTool.execute(
        { command: 'node -e "process.stdout.write(process.env.OPENAI_API_KEY ?? \'\')"' },
        ctx,
      );
      expect(result.isError).toBeUndefined();
      // Empty stdout renders as the tool's own "(no output)" placeholder, not "".
      expect(result.content.trim()).toBe('(no output)');
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });
});
