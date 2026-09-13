/**
 * SPIKE (Phase 4, not yet wired into the live loop): progressive disclosure for
 * MCP tools, the hybrid policy.
 *
 * Today every MCP tool's full JSON Schema ships in the tool payload every turn
 * (see `McpHub.toolSpecs` → `ToolRegistry`). Skills are disclosed progressively;
 * MCP tools are not. This catalog partitions the discovered MCP tools into:
 *
 *   - `inline`   — full schemas, registered as tools as they are today. Small
 *                  servers (≤ `inlineServerMaxTools`) stay here until a token
 *                  budget (`maxInlineTokens`) is spent, so the common one- or
 *                  two-small-server setup pays no round-trip.
 *   - `deferred` — advertised name+description only, via the `<available_mcp_tools>`
 *                  manifest; the model loads a specific tool's full schema on
 *                  demand (the eventual `mcp_tool_search`/load tool) before calling it.
 *
 * This module is pure partitioning + token accounting so the savings can be
 * measured before the runtime wiring (a load tool that registers a deferred
 * spec into the live registry, plus a prompt segment behind a flag) is built.
 * Nothing here is imported by the agent loop yet, so it changes no prompt bytes.
 */

import { heuristicTokenCount, type TokenCounter } from '../context/tokenizer.js';
import type { AnyToolSpec } from '../tools/types.js';
import { toolDefinition } from '../tools/types.js';

/** Token budget for inline MCP tool schemas before the rest defer. */
export const DEFAULT_MAX_INLINE_TOKENS = 4000;
/** A server with more tools than this always defers (it's the context hog). */
export const DEFAULT_INLINE_SERVER_MAX_TOOLS = 10;

const MANIFEST_PREAMBLE =
  'MCP tools available on demand. Only the ones listed inline as full tools can be ' +
  'called directly; to call one of these, first load its schema with the ' +
  '`mcp_tool_search` tool, then call it by name.';

export interface McpToolCatalogOptions {
  maxInlineTokens?: number;
  inlineServerMaxTools?: number;
  count?: TokenCounter;
}

/** `mcp__<server>__<tool>` → `<server>`, or `undefined` for a non-MCP name. */
export function mcpServerOf(toolName: string): string | undefined {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(toolName);
  return m ? m[1] : undefined;
}

/** Token cost of a tool as the model sees it: its JSON tool definition. */
export function schemaTokens(spec: AnyToolSpec, count: TokenCounter = heuristicTokenCount): number {
  return count(JSON.stringify(toolDefinition(spec)));
}

export class McpToolCatalog {
  /** Full-schema tools registered as they are today. */
  readonly inline: AnyToolSpec[];
  /** Advertised name+description only; loaded on demand. */
  readonly deferred: AnyToolSpec[];
  private readonly byName = new Map<string, AnyToolSpec>();
  private readonly count: TokenCounter;

  constructor(specs: readonly AnyToolSpec[], opts: McpToolCatalogOptions = {}) {
    const maxInline = opts.maxInlineTokens ?? DEFAULT_MAX_INLINE_TOKENS;
    const serverMax = opts.inlineServerMaxTools ?? DEFAULT_INLINE_SERVER_MAX_TOOLS;
    this.count = opts.count ?? heuristicTokenCount;
    for (const s of specs) this.byName.set(s.name, s);

    // Group by server, stable order.
    const byServer = new Map<string, AnyToolSpec[]>();
    for (const s of specs) {
      const server = mcpServerOf(s.name) ?? '';
      (byServer.get(server) ?? byServer.set(server, []).get(server)!).push(s);
    }

    const inline: AnyToolSpec[] = [];
    const deferred: AnyToolSpec[] = [];
    let running = 0;
    for (const server of [...byServer.keys()].sort()) {
      const tools = byServer.get(server)!;
      const serverCost = tools.reduce((n, t) => n + schemaTokens(t, this.count), 0);
      const fits = tools.length <= serverMax && running + serverCost <= maxInline;
      if (fits) {
        inline.push(...tools);
        running += serverCost;
      } else {
        deferred.push(...tools);
      }
    }
    this.inline = inline;
    this.deferred = deferred;
  }

  get(name: string): AnyToolSpec | undefined {
    return this.byName.get(name);
  }

  /** Deferred tools whose name or description contains `query` (case-insensitive). */
  search(query: string): AnyToolSpec[] {
    const q = query.toLowerCase();
    return this.deferred.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q),
    );
  }

  /** The `<available_mcp_tools>` segment for deferred tools, or `undefined` when none defer. */
  manifest(): string | undefined {
    if (this.deferred.length === 0) return undefined;
    const lines = this.deferred.map((s) => `- ${s.name}: ${firstLine(s.description)}`);
    return `<available_mcp_tools>\n${MANIFEST_PREAMBLE}\n\n${lines.join('\n')}\n</available_mcp_tools>`;
  }

  // --- measurement (spike) ---

  /** Tokens the inline schemas cost — what still ships every turn. */
  inlineTokens(): number {
    return this.inline.reduce((n, s) => n + schemaTokens(s, this.count), 0);
  }

  /** Tokens the deferred manifest costs — the fixed advertisement price. */
  manifestTokens(): number {
    const m = this.manifest();
    return m ? this.count(m) : 0;
  }

  /** Baseline: tokens if every MCP tool shipped inline, as today. */
  static allInlineTokens(
    specs: readonly AnyToolSpec[],
    count: TokenCounter = heuristicTokenCount,
  ): number {
    return specs.reduce((n, s) => n + schemaTokens(s, count), 0);
  }
}

function firstLine(desc: string | undefined): string {
  const line = (desc ?? '').split('\n')[0]!.trim();
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}
