/**
 * The `/` menu's command list. Three sources, one list:
 *  - client-side (`/help`, `/clear`) — never reach the server,
 *  - server-side (`/compact`, `/plan`) — `SessionHost` handles them,
 *  - MCP prompts — whatever `session.slashCommands` reports.
 */

import type { SlashCommandInfo } from '@harness-code/core';

export type SlashSource = 'client' | 'server' | 'mcp';

export interface SlashCommand {
  name: string;
  hint: string;
  source: SlashSource;
}

export const CLIENT_COMMANDS: SlashCommand[] = [
  { name: 'help', hint: 'Commands and keyboard shortcuts', source: 'client' },
  { name: 'clear', hint: 'Start a fresh session', source: 'client' },
];

export const SERVER_COMMANDS: SlashCommand[] = [
  { name: 'compact', hint: 'Summarise the context now', source: 'server' },
  { name: 'plan', hint: 'Switch to plan mode', source: 'server' },
];

export function allCommands(mcp: readonly SlashCommandInfo[] = []): SlashCommand[] {
  return [
    ...CLIENT_COMMANDS,
    ...SERVER_COMMANDS,
    ...mcp.map((p) => ({ name: p.command, hint: `${p.server} prompt`, source: 'mcp' as const })),
  ];
}

/**
 * The menu is open only while the text is a single `/token` — the first line,
 * no whitespace yet, so `/compact` matches but `/mcp foo bar` (already typing
 * arguments) does not. Returns null when the menu should be closed.
 */
export function slashQuery(text: string): string | null {
  const m = /^\/(\S*)$/.exec(text);
  return m ? (m[1] ?? '') : null;
}

/** Prefix matches first, then substring; stable within each group. */
export function filterCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (q === '') return [...commands];
  const prefix: SlashCommand[] = [];
  const rest: SlashCommand[] = [];
  for (const c of commands) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(c);
    else if (name.includes(q)) rest.push(c);
  }
  return [...prefix, ...rest];
}
