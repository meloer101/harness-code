/**
 * `./browser` is the browser-safe subpath the web frontend imports (docs/
 * web.md, "Core changes required"). The one guarantee that matters is: no
 * `node:*` module ever ends up in its module graph. `import type` alone
 * won't catch that — a type-only re-export of something with a runtime
 * `node:fs` import is fine; a *value* re-export of the same thing is not.
 * Bundling with esbuild's `platform: 'browser'` is the real check: it makes
 * esbuild resolve every import as a browser would, so a bare `node:fs`
 * import fails the build instead of silently becoming a no-op polyfill.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, 'browser.ts');

async function bundleBrowserEntry(entryPoint: string) {
  return build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    logLevel: 'silent',
  });
}

describe('core/browser entry point', () => {
  it('bundles cleanly for the browser', async () => {
    const result = await bundleBrowserEntry(entry);
    expect(result.outputFiles).toHaveLength(1);
  });

  it('never emits a reference to a node:* import in the bundled output', async () => {
    const result = await bundleBrowserEntry(entry);
    const code = result.outputFiles[0]!.text;
    expect(code).not.toMatch(/["']node:/);
  });

  it('exports the expected runtime functions', async () => {
    const result = await bundleBrowserEntry(entry);
    const code = result.outputFiles[0]!.text;
    expect(code).toContain('describeToolInput');
    expect(code).toContain('fmtTokens');
    expect(code).toContain('fmtUSD');
  });

  it('regression guard: a module with a real node:* dependency fails this same build', async () => {
    // Proves the checks above aren't vacuous — pointing esbuild at a module
    // that *does* import node builtins (`agent/session.ts`, `node:fs/promises`
    // et al.) must fail under `platform: 'browser'`.
    await expect(
      build({
        stdin: {
          contents: `export * from ${JSON.stringify(resolve(here, 'agent/session.ts'))};`,
          resolveDir: here,
          loader: 'ts',
        },
        bundle: true,
        platform: 'browser',
        format: 'esm',
        write: false,
        logLevel: 'silent',
      }),
    ).rejects.toThrow();
  });
});
