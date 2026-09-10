/**
 * `@harness-code/protocol` is imported directly by the web frontend (docs/
 * web.md: "packages/protocol ... no node deps (web imports it)"). The
 * tsconfig (`lib: ES2023`, no `types: ["node"]`) already fails the *build*
 * if this package's own source uses a node API, but it can't catch a value
 * import of a core symbol whose runtime module graph pulls in `node:*` —
 * `import type` is erased, but a plain `import` is not. Bundling for the
 * browser is the real check, same pattern as `core/src/browser.bundle.test.ts`.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, 'index.ts');

async function bundleForBrowser(entryPoint: string) {
  return build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    logLevel: 'silent',
  });
}

describe('protocol entry point', () => {
  it('bundles cleanly for the browser', async () => {
    const result = await bundleForBrowser(entry);
    expect(result.outputFiles).toHaveLength(1);
  });

  it('never emits a reference to a node:* import in the bundled output', async () => {
    const result = await bundleForBrowser(entry);
    const code = result.outputFiles[0]!.text;
    expect(code).not.toMatch(/["']node:/);
  });

  it('exports the expected runtime values', async () => {
    const result = await bundleForBrowser(entry);
    const code = result.outputFiles[0]!.text;
    expect(code).toContain('foldReducer');
    expect(code).toContain('EventBuffer');
    expect(code).toContain('methods');
  });

  it('regression guard: a module with a real node:* dependency fails this same build', async () => {
    // Proves the checks above aren't vacuous — pointing esbuild at a core
    // module that *does* import node builtins must fail under `platform:
    // 'browser'`, same as core's own guard.
    const coreSessionModule = resolve(here, '../../core/src/agent/session.ts');
    await expect(
      build({
        stdin: {
          contents: `export * from ${JSON.stringify(coreSessionModule)};`,
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
