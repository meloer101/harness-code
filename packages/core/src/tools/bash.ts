import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { z } from 'zod';

import { PathEscapeError, assertInsideWorkspace } from '../permissions/paths.js';
import { sandboxedEnv } from '../permissions/sandbox.js';
import type { ToolResult, ToolSpec } from './types.js';
import { errorMessage } from './util.js';

const schema = z.object({
  command: z.string().describe('Shell command to run.'),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Kill the command after this many milliseconds (default 120000).'),
  cwd: z.string().optional().describe('Directory to run in, relative to the workspace root.'),
});

type Input = z.infer<typeof schema>;

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 30_000;
const HEAD_CHARS = 20_000;
const TAIL_CHARS = 8_000;
const KILL_GRACE_MS = 2_000;

/**
 * No command-line vetting or environment filtering here on purpose — that is
 * Phase 3's job (AST-based review, env allowlist, sandbox-exec). This tool is
 * spawn + timeout + output cap only.
 */
export const bashTool: ToolSpec<Input> = {
  name: 'bash',
  description: 'Run a shell command in the workspace and return its combined stdout/stderr.',
  schema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input, ctx) {
    const requestedCwd = input.cwd ? resolve(ctx.cwd, input.cwd) : ctx.cwd;
    let cwd: string;
    try {
      cwd = await assertInsideWorkspace(ctx.cwd, requestedCwd);
    } catch (err) {
      const message = err instanceof PathEscapeError ? err.message : errorMessage(err);
      return { content: message, isError: true };
    }
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<ToolResult>((resolvePromise) => {
      const child = spawn('/bin/sh', ['-c', input.command], {
        cwd,
        env: sandboxedEnv(),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      let output = '';
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      }, timeoutMs);

      const finish = (result: ToolResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(result);
      };

      child.stdout?.on('data', (d: Buffer) => {
        output += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        output += d.toString();
      });

      child.on('close', (code) => {
        const truncated = truncateOutput(output);
        if (timedOut) {
          finish({
            content: `${truncated}\n[command timed out after ${timeoutMs}ms]`,
            isError: true,
          });
        } else if (code !== 0) {
          finish({ content: `${truncated}\n[exit code ${code}]`, isError: true });
        } else {
          finish({ content: truncated || '(no output)' });
        }
      });

      child.on('error', (err) => {
        finish({ content: `Could not run command: ${err.message}`, isError: true });
      });
    });
  },
};

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const omitted = output.length - HEAD_CHARS - TAIL_CHARS;
  return (
    `${output.slice(0, HEAD_CHARS)}\n... ${omitted} characters omitted ...\n` +
    output.slice(-TAIL_CHARS)
  );
}
