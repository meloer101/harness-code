/**
 * A small, dependency-free HTML → Markdown converter for `webfetch`.
 *
 * The goal is "reader mode", not fidelity: strip the chrome (scripts, styles,
 * nav, svg) and emit the block structure a model needs to read an article —
 * headings, paragraphs, lists, links, code, blockquotes. Claude Code and Codex
 * both do this step server-side; Marvis is a local, provider-agnostic CLI, so
 * it does it here, in a single pass over the markup with no parser dependency.
 *
 * This is intentionally forgiving: malformed markup degrades to plain text
 * rather than throwing. If fidelity ever matters more than footprint, this one
 * function can be swapped for `turndown` without touching the tool.
 */

/** Elements whose entire subtree is dropped before any text is emitted. */
const DROP_ELEMENTS = ['script', 'style', 'noscript', 'svg', 'head', 'iframe', 'template'];

/** Decode the handful of HTML entities common in article text. */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
}

/** Pull the `<title>` (before it is stripped) for use as a leading heading. */
function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return undefined;
  const t = decodeEntities(m[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t || undefined;
}

/** Remove `<script>…</script>` and friends, subtree and all. */
function stripDropElements(html: string): string {
  let out = html;
  for (const tag of DROP_ELEMENTS) {
    out = out.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
    // Self-closing / unclosed variants (e.g. a stray <svg .../>).
    out = out.replace(new RegExp(`<${tag}[^>]*/?>`, 'gi'), ' ');
  }
  // HTML comments.
  return out.replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * Convert the block-level tags we care about into newline-delimited markdown
 * markers, then strip whatever tags remain. Order matters: links and code are
 * turned into text before the generic tag strip removes their wrappers.
 */
function convertBlocks(html: string): string {
  let s = html;

  // Links: <a href="x">text</a> -> [text](x). Drop empty or javascript: hrefs.
  s = s.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, '').trim();
    const url = href.trim();
    if (!text) return '';
    if (!url || /^javascript:/i.test(url)) return text;
    return `[${text}](${url})`;
  });

  // Inline code and pre blocks.
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner: string) => {
    const code = inner.replace(/<[^>]+>/g, '');
    return `\n\n\`\`\`\n${decodeEntities(code).replace(/\n+$/, '')}\n\`\`\`\n\n`;
  });
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner: string) => {
    return `\`${inner.replace(/<[^>]+>/g, '')}\``;
  });

  // Headings -> #..###### .
  for (let level = 1; level <= 6; level++) {
    s = s.replace(new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi'), (_, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      return text ? `\n\n${'#'.repeat(level)} ${text}\n\n` : '';
    });
  }

  // List items -> "- ". (Nesting is flattened; good enough for reading.)
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner: string) => `\n- ${inner.trim()}`);

  // Blockquote -> "> ".
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, '').trim();
    return text ? `\n\n> ${text.replace(/\n+/g, '\n> ')}\n\n` : '';
  });

  // Block separators become blank lines; <br> becomes a newline.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|header|footer|ul|ol|table|tr|h[1-6])>/gi, '\n\n');
  s = s.replace(/<hr\s*\/?>/gi, '\n\n---\n\n');

  // Drop every remaining tag.
  s = s.replace(/<[^>]+>/g, '');
  return s;
}

/** Collapse the whitespace left behind so the output is readable, not sparse. */
function tidy(text: string): string {
  return decodeEntities(text)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}

/** Convert an HTML document to reader-mode markdown. Never throws. */
export function htmlToMarkdown(html: string): string {
  const title = extractTitle(html);
  const stripped = stripDropElements(html);
  const converted = convertBlocks(stripped);
  const body = tidy(converted);
  if (title && !body.startsWith(`# ${title}`)) {
    return `# ${title}\n\n${body}`.trimEnd();
  }
  return body;
}
