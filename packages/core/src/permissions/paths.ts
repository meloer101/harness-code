import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export class PathEscapeError extends Error {
  readonly target: string;

  constructor(target: string, detail?: string) {
    super(detail ?? `Path escapes the workspace: ${target}`);
    this.name = 'PathEscapeError';
    this.target = target;
  }
}

export function isInsideWorkspace(workspaceRoot: string, target: string): boolean {
  const root = workspaceRoot.endsWith(sep) ? workspaceRoot.slice(0, -1) : workspaceRoot;
  return target === root || target.startsWith(root + sep);
}

/**
 * Resolve `target` against the workspace, following symlinks. Files that do not
 * exist yet are resolved via the nearest existing ancestor so `../` and
 * symlink hops cannot sneak a create outside the cage.
 */
export async function resolveInWorkspace(workspaceRoot: string, target: string): Promise<string> {
  const root = await realpath(workspaceRoot);
  const abs = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const resolved = await realpathExistingOrJoin(abs);
  if (!isInsideWorkspace(root, resolved)) {
    throw new PathEscapeError(target);
  }
  return resolved;
}

export async function assertInsideWorkspace(workspaceRoot: string, target: string): Promise<string> {
  return resolveInWorkspace(workspaceRoot, target);
}

export async function relativeToWorkspace(workspaceRoot: string, target: string): Promise<string> {
  const root = await realpath(workspaceRoot);
  const resolved = await resolveInWorkspace(workspaceRoot, target);
  const rel = relative(root, resolved);
  return rel.split(sep).join('/');
}

async function realpathExistingOrJoin(abs: string): Promise<string> {
  try {
    return await realpath(abs);
  } catch {
    const tail: string[] = [];
    let current = abs;
    for (;;) {
      tail.unshift(basename(current));
      const parent = dirname(current);
      if (parent === current) {
        return abs;
      }
      try {
        const parentReal = await realpath(parent);
        return join(parentReal, ...tail);
      } catch {
        current = parent;
      }
    }
  }
}

const SENSITIVE_BASENAME = /^(id_rsa(\.pub)?|.+\.pem)$/i;

export function isSensitivePath(relPosix: string): boolean {
  const n = relPosix.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = n.split('/');
  const base = parts[parts.length - 1] ?? '';

  if (base === '.env' || base.startsWith('.env')) return true;
  if (n === '.git/config' || n.endsWith('/.git/config')) return true;
  if (SENSITIVE_BASENAME.test(base)) return true;
  if (/credential/i.test(base)) return true;
  if (/^secrets?\.json$/i.test(base)) return true;
  return false;
}
