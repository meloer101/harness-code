/**
 * Startup banner — the "MARVIS" wordmark printed once, above the Ink app.
 *
 * Written straight to stdout before `render()` mounts (see `runTui`): it lands
 * at the top of the terminal and rides up into scrollback as the transcript
 * grows, matching how Claude Code / Codex show their splash. Kept out of the
 * React tree so it never competes with Ink's live redraw.
 */

import type { Theme } from './theme.js';

/** figlet "ANSI Shadow", rendered once at launch. */
const MARVIS: readonly string[] = [
  '███╗   ███╗  █████╗  ██████╗  ██╗   ██╗ ██╗ ███████╗',
  '████╗ ████║ ██╔══██╗ ██╔══██╗ ██║   ██║ ██║ ██╔════╝',
  '██╔████╔██║ ███████║ ██████╔╝ ██║   ██║ ██║ ███████╗',
  '██║╚██╔╝██║ ██╔══██║ ██╔══██╗ ╚██╗ ██╔╝ ██║ ╚════██║',
  '██║ ╚═╝ ██║ ██║  ██║ ██║  ██║  ╚████╔╝  ██║ ███████║',
  '╚═╝     ╚═╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝   ╚═══╝   ╚═╝ ╚══════╝',
];

const RESET = '\x1b[0m';

/** A truecolor SGR prefix from a `#rrggbb` theme colour. */
function fg(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

/**
 * The banner as a ready-to-write string: the wordmark in the theme accent, a
 * dim tagline underneath, padded with blank lines above and below.
 */
export function renderBanner(theme: Theme): string {
  const accent = fg(theme.accent);
  const dim = fg(theme.dim);
  const art = MARVIS.map((line) => `  ${accent}${line}${RESET}`).join('\n');
  const tagline = `  ${dim}coding agent · type /help for commands${RESET}`;
  return `\n${art}\n\n${tagline}\n\n`;
}
