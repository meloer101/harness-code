/**
 * `@server:uri` resource references.
 *
 * When a user message contains `@fs:file:///path/to/README.md`, the referenced
 * MCP resource is fetched and prepended to the turn as context, the same way
 * Claude Code splices `@`-mentioned files in. The token stays in the message
 * text so the model sees what was asked for.
 */

import type { McpHub } from './hub.js';

const REFERENCE_RE = /@([A-Za-z0-9_-]+):(\S+)/g;

export interface ResolvedResources {
  /** Blocks to prepend to the turn, one per resolved reference. */
  context: string[];
  /** Human-readable notes (failures included), for the CLI to echo. */
  notes: string[];
}

export function findResourceReferences(text: string): { server: string; uri: string }[] {
  const out: { server: string; uri: string }[] = [];
  for (const m of text.matchAll(REFERENCE_RE)) {
    out.push({ server: m[1] as string, uri: (m[2] as string).replace(/[).,;]+$/, '') });
  }
  return out;
}

export async function resolveResources(hub: McpHub, text: string): Promise<ResolvedResources> {
  const refs = findResourceReferences(text);
  const context: string[] = [];
  const notes: string[] = [];
  for (const { server, uri } of refs) {
    const conn = hub.connection(server);
    if (!conn) {
      notes.push(`@${server}:${uri} — no MCP server named "${server}"`);
      continue;
    }
    try {
      const body = await conn.readResource(uri);
      context.push(`<resource server="${server}" uri="${uri}">\n${body}\n</resource>`);
      notes.push(`@${server}:${uri} — ${body.length} chars`);
    } catch (err) {
      notes.push(`@${server}:${uri} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { context, notes };
}
