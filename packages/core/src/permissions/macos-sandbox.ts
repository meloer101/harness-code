/**
 * OS-level backstop for the bash tool, on top of (not instead of) the
 * text-review path in `bash-ast.ts`. Everything upstream of this file is
 * "does this command look safe before we spawn it" — this is the one place
 * that asks the OS to enforce something itself, so a pattern our AST review
 * never anticipated still can't write outside the workspace.
 *
 * Scoped to exactly what it's for: workspace read-write, everything else
 * read-only. Reads, network, and process-exec are left alone — a
 * from-scratch Seatbelt profile that also tries to lock those down is far
 * more likely to break ordinary tool use (DNS lookups, dynamic linking,
 * spawning subprocesses) than to add real value here. macOS only —
 * `sandbox-exec` (Seatbelt) has no equivalent on this project's other
 * target platforms, so elsewhere this degrades to the unsandboxed spawn
 * that's always been there.
 */

import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

let cachedAvailable: boolean | undefined;

/** Whether `sandbox-exec` is available on this machine. Checked once and memoized — this can't change mid-run. */
export function isSandboxExecAvailable(): boolean {
  if (cachedAvailable === undefined) {
    cachedAvailable = process.platform === 'darwin' && existsSync(SANDBOX_EXEC_PATH);
  }
  return cachedAvailable;
}

/** Pure string builder — no filesystem or platform checks, so it's testable everywhere. */
export function buildSandboxProfile(workspaceRoot: string, extraWritablePaths: readonly string[] = []): string {
  const allowClauses = [workspaceRoot, ...extraWritablePaths]
    .map((p) => `(allow file-write* (subpath "${escapeProfilePath(p)}"))`)
    .join('\n');
  return `(version 1)\n(allow default)\n(deny file-write* (subpath "/"))\n${DEVICE_WRITES}\n${allowClauses}`;
}

/**
 * Character devices that ordinary commands open for writing and that can't
 * persist anything: without these, `git` (and anything else that opens
 * `/dev/null` read-write) dies with "could not open '/dev/null' ...
 * Operation not permitted", and redirects to the terminal fail.
 */
const DEVICE_WRITES =
  '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") ' +
  '(regex #"^/dev/tty") (regex #"^/dev/fd/"))';

function escapeProfilePath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface WrappedCommand {
  cmd: string;
  args: string[];
}

/**
 * Wraps a `/bin/sh` invocation with `sandbox-exec` when available, confining
 * writes to `workspaceRoot` and the OS temp dir (real tools routinely need
 * scratch space there). `available` defaults to the real Darwin-only check
 * but is injectable so the wrapping logic itself is testable on any CI
 * platform, independent of whether `sandbox-exec` actually exists there.
 */
export function wrapCommand(
  shellArgs: readonly string[],
  workspaceRoot: string,
  available: boolean = isSandboxExecAvailable(),
): WrappedCommand {
  if (!available) return { cmd: '/bin/sh', args: [...shellArgs] };
  const profile = buildSandboxProfile(workspaceRoot, [tmpdir()]);
  return { cmd: SANDBOX_EXEC_PATH, args: ['-p', profile, '/bin/sh', ...shellArgs] };
}
