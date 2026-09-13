/**
 * Build the published `marvis` package: one self-contained npm package with a
 * single version line, so a user installs it with one command
 * (`npm i -g marvis`) and updates it with one (`npm update -g marvis`) — no
 * transitive @harness-code/* packages, no version pile-up.
 *
 * Unlike `bundle-hc.mjs` (a headless benchmark artifact that leaves the TUI
 * external), this bundles the TUI in, so the interactive `marvis` a user gets
 * is the real one. Ink's dev-only `react-devtools-core` import is stubbed to an
 * empty module — it is never reached unless `DEV=true`, and left unstubbed its
 * eager ESM import crashes even `marvis --version`.
 *
 * The builtin skills/agents/memory are read at runtime via
 * `new URL('../../skills/', import.meta.url)` etc. (see
 * packages/core/src/skills/discover.ts). With the bundle placed at
 * `dist/bundle/marvis.mjs`, `../../` lands on the package root, so those data
 * directories are copied there to keep the paths resolving.
 *
 * Usage: `node scripts/bundle-marvis.mjs` (or `pnpm release:marvis`).
 * Prerequisite: `pnpm build` (needs the packages' dist output and, for
 * `marvis web`, the web package's dist).
 */

import { build } from 'esbuild';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'release');
const bundleDir = resolve(outDir, 'dist/bundle');
const outfile = resolve(bundleDir, 'marvis.mjs');

/** Single source of truth for the published version: the runtime VERSION constant. */
async function readVersion() {
  const src = await readFile(resolve(root, 'packages/core/src/version.ts'), 'utf8');
  const m = src.match(/VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!m) throw new Error('Could not read VERSION from packages/core/src/version.ts');
  return m[1];
}

/** Replace ink's optional dev-tools import with a no-op so the bundle is self-contained. */
const stubDevtools = {
  name: 'stub-react-devtools-core',
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'stub-devtools',
    }));
    b.onLoad({ filter: /.*/, namespace: 'stub-devtools' }, () => ({
      contents: 'export default {}; export const connectToDevTools = () => {};',
      loader: 'js',
    }));
  },
};

const version = await readVersion();

// Start from a clean release dir so a stale file can never ship.
await rm(outDir, { recursive: true, force: true });
await mkdir(bundleDir, { recursive: true });

await build({
  entryPoints: [resolve(root, 'packages/cli/src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  plugins: [stubDevtools],
  // Some transitive deps use CJS `require` at runtime; give the ESM output one.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
await chmod(outfile, 0o755);

// Runtime data directories, placed so `../../<dir>` from dist/bundle/ resolves.
for (const dir of ['skills', 'agents', 'memory']) {
  const from = resolve(root, 'packages/core', dir);
  if (existsSync(from)) {
    await cp(from, resolve(outDir, dir), { recursive: true });
    console.log(`copied ${dir}/`);
  } else {
    console.log(`(skipped ${dir}/ — not present)`);
  }
}

// Web UI bundle for `marvis web`, if built. resolveStaticDir() looks for a
// `web` dir next to the running file (packages/server/src/http.ts).
const webDist = resolve(root, 'packages/web/dist');
if (existsSync(webDist)) {
  await cp(webDist, resolve(bundleDir, 'web'), { recursive: true });
  console.log('copied web UI bundle');
} else {
  console.log('(skipped web UI — packages/web/dist not built; `marvis web` shows a placeholder)');
}

await cp(resolve(root, 'LICENSE'), resolve(outDir, 'LICENSE'));
await cp(resolve(root, 'README.md'), resolve(outDir, 'README.md'));

const pkg = {
  name: 'marvis',
  version,
  description: 'A coding agent you can read all of — MCP client/server, skills, plan mode, sub-agents, and a permission sandbox, over any OpenAI-compatible model.',
  type: 'module',
  bin: { marvis: 'dist/bundle/marvis.mjs', hc: 'dist/bundle/marvis.mjs' },
  files: ['dist', 'skills', 'agents', 'memory', 'README.md', 'LICENSE'],
  engines: { node: '>=20.10' },
  license: 'MIT',
  author: 'Jacoy',
  homepage: 'https://github.com/meloer101/harness-code#readme',
  repository: { type: 'git', url: 'git+https://github.com/meloer101/harness-code.git' },
  bugs: { url: 'https://github.com/meloer101/harness-code/issues' },
  keywords: ['ai', 'agent', 'coding-agent', 'cli', 'llm', 'mcp', 'deepseek', 'openai-compatible'],
};
await writeFile(resolve(outDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`\nmarvis@${version} -> ${outDir}`);
console.log('Next: cd release && npm publish   (or: npm pack, then install the tarball to smoke-test)');
