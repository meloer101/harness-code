/**
 * Lazy syntax highlighting (t3code-style: plain text while streaming, Shiki
 * once the message settles). Everything here is a dynamic import, so the
 * highlighter and each grammar are separate chunks fetched on first use.
 *
 * Shiki's JavaScript regex engine instead of the default Oniguruma WASM: the
 * server's CSP (`script-src 'self'`) doesn't allow WebAssembly compilation.
 */

import type { HighlighterCore, LanguageRegistration } from 'shiki/core';

type LangModule = { default: LanguageRegistration[] };

/** A deliberately small set — what a coding agent actually prints. */
const LANGS: Record<string, () => Promise<LangModule>> = {
  typescript: () => import('shiki/dist/langs/typescript.mjs'),
  tsx: () => import('shiki/dist/langs/tsx.mjs'),
  javascript: () => import('shiki/dist/langs/javascript.mjs'),
  jsx: () => import('shiki/dist/langs/jsx.mjs'),
  json: () => import('shiki/dist/langs/json.mjs'),
  bash: () => import('shiki/dist/langs/bash.mjs'),
  python: () => import('shiki/dist/langs/python.mjs'),
  go: () => import('shiki/dist/langs/go.mjs'),
  rust: () => import('shiki/dist/langs/rust.mjs'),
  diff: () => import('shiki/dist/langs/diff.mjs'),
  markdown: () => import('shiki/dist/langs/markdown.mjs'),
  yaml: () => import('shiki/dist/langs/yaml.mjs'),
  toml: () => import('shiki/dist/langs/toml.mjs'),
  css: () => import('shiki/dist/langs/css.mjs'),
  html: () => import('shiki/dist/langs/html.mjs'),
  sql: () => import('shiki/dist/langs/sql.mjs'),
};

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsonc: 'json',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  py: 'python',
  rs: 'rust',
  md: 'markdown',
  yml: 'yaml',
  patch: 'diff',
};

/** Canonical grammar name for a fence info string / file extension, or null if unsupported. */
export function resolveLang(lang: string | undefined): string | null {
  if (!lang) return null;
  const key = lang.toLowerCase();
  const name = ALIASES[key] ?? key;
  return name in LANGS ? name : null;
}

/** File extension → grammar, for tool cards that show file content. */
export function langForPath(path: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1];
  return resolveLang(ext);
}

let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/dist/themes/github-light.mjs'),
      import('shiki/dist/themes/github-dark.mjs'),
    ]);
    return createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return highlighter;
}

/**
 * Highlight `code` as HTML with both themes as CSS variables (`--shiki-light`
 * / `--shiki-dark`, switched in index.css). Null for unsupported languages or
 * if loading fails — callers keep showing the plain text.
 */
export async function highlight(code: string, lang: string | undefined): Promise<string | null> {
  const name = resolveLang(lang);
  if (!name) return null;
  try {
    const h = await getHighlighter();
    let ready = loaded.get(name);
    if (!ready) {
      ready = LANGS[name]!().then((m) => h.loadLanguage(...m.default));
      loaded.set(name, ready);
    }
    await ready;
    return h.codeToHtml(code, {
      lang: name,
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
    });
  } catch {
    return null;
  }
}
