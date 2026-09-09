/**
 * Bundle the `hc` CLI into a single self-contained ESM file for shipping into
 * a sandbox container (Harbor / Terminal-Bench). `hc` is a pnpm-workspace app
 * that is never published to npm, so a benchmark harness cannot `npm i` it;
 * this produces one `dist-bundle/hc.mjs` that runs under a bare `node`.
 *
 * `@harness-code/tui` is left external on purpose: the CLI's import of it is
 * already wrapped in try/catch (`packages/cli/src/index.ts`, the `frontend ===
 * 'tui'` branch) and falls back to the one-shot / REPL path when it is missing,
 * which is exactly what a headless run wants. Everything else — core and its
 * runtime deps (fast-glob, gray-matter, js-tiktoken, shell-quote, yaml, zod,
 * @modelcontextprotocol/sdk) — is pure JS and bundles cleanly.
 *
 * Usage: `node scripts/bundle-hc.mjs` (or `pnpm bundle`).
 */

import { build } from 'esbuild';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'dist-bundle/hc.mjs');

await mkdir(dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [resolve(root, 'packages/cli/src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  external: ['@harness-code/tui'],
  // The dynamic `import('@harness-code/tui')` becomes a runtime require that
  // will throw ERR_MODULE_NOT_FOUND in the container; the CLI catches it. Keep
  // esbuild from trying to resolve it at build time.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
  metafile: true,
});

await writeFile(
  resolve(root, 'dist-bundle/hc.mjs.meta.json'),
  JSON.stringify(result.metafile, null, 2),
);
await chmod(outfile, 0o755);

console.log(`\nbundled -> ${outfile}`);
