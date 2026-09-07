/**
 * `.mcp.json` loading.
 *
 * Same shape Claude Code uses, so a server the ecosystem already documents for
 * Claude Code works here unchanged:
 *
 *   { "mcpServers": {
 *       "fs":  { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *       "api": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${API_TOKEN}" } }
 *   } }
 *
 * Two layers, most specific last: `~/.agent/.mcp.json` then the project root's
 * `.mcp.json`. A later layer replaces a server of the same name outright — MCP
 * server definitions are not the kind of thing you deep-merge. Neither file has
 * to exist.
 *
 * `${ENV_VAR}` in any string value (url, args, env values, header values) is
 * substituted from the process environment. This is the whole of the HTTP auth
 * story: put `Bearer ${TOKEN}` in a header and keep the secret in the env.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AGENT_DIR, findProjectRoot } from '../config/settings.js';

export interface McpStdioServerConfig {
  name: string;
  transport: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpHttpServerConfig {
  name: string;
  /** `http` = streamable HTTP; `sse` = the older SSE transport (Linear still uses it). */
  transport: 'http' | 'sse';
  url: string;
  headers: Record<string, string>;
  /**
   * `oauth` forces the OAuth flow; `none` forces static-only (headers must carry
   * the credential). Omitted = auto: OAuth unless `headers.Authorization` is set.
   */
  auth?: 'oauth' | 'none';
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export const MCP_CONFIG_FILE = '.mcp.json';

export interface LoadedMcpConfig {
  servers: McpServerConfig[];
  /** Files actually read, in application order. For `hc doctor` / `hc mcp list`. */
  sources: string[];
}

export async function loadMcpConfig(cwd = process.cwd()): Promise<LoadedMcpConfig> {
  const candidates = [
    join(homedir(), AGENT_DIR, MCP_CONFIG_FILE),
    join(await findProjectRoot(cwd), MCP_CONFIG_FILE),
  ];

  const byName = new Map<string, McpServerConfig>();
  const sources: string[] = [];

  for (const path of candidates) {
    const raw = await readOptional(path);
    if (raw === undefined) continue;
    for (const server of parseMcpConfig(raw, path)) byName.set(server.name, server);
    sources.push(path);
  }

  return { servers: [...byName.values()], sources };
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined; // absent is the normal case
  }
}

/** Exported for tests; the file loader is a thin wrapper over this. */
export function parseMcpConfig(raw: string, label = '.mcp.json'): McpServerConfig[] {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const servers = (doc as { mcpServers?: unknown }).mcpServers;
  if (servers === undefined) return [];
  if (typeof servers !== 'object' || servers === null) {
    throw new Error(`${label}: "mcpServers" must be an object`);
  }

  const out: McpServerConfig[] = [];
  for (const [name, entryRaw] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof entryRaw !== 'object' || entryRaw === null) {
      throw new Error(`${label}: server "${name}" must be an object`);
    }
    const entry = entryRaw as Record<string, unknown>;
    const type = typeof entry.type === 'string' ? entry.type : undefined;
    const isHttp = type === 'http' || type === 'sse' || (type === undefined && typeof entry.url === 'string');

    if (isHttp) {
      if (typeof entry.url !== 'string') {
        throw new Error(`${label}: server "${name}" is http but has no "url"`);
      }
      const url = interpolate(entry.url);
      // SSE is chosen explicitly, or inferred from the conventional `/sse` path.
      const transport: 'http' | 'sse' =
        type === 'sse' || (type === undefined && /\/sse\/?(?:$|\?)/.test(url)) ? 'sse' : 'http';
      const auth = entry.auth;
      if (auth !== undefined && auth !== 'oauth' && auth !== 'none') {
        throw new Error(`${label}: server "${name}" auth must be "oauth" or "none"`);
      }
      out.push({
        name,
        transport,
        url,
        headers: interpolateRecord(asStringRecord(entry.headers, `${label}: server "${name}" headers`)),
        ...(auth !== undefined ? { auth: auth as 'oauth' | 'none' } : {}),
      });
      continue;
    }

    if (typeof entry.command !== 'string' || entry.command === '') {
      throw new Error(`${label}: server "${name}" has no "command"`);
    }
    out.push({
      name,
      transport: 'stdio',
      command: entry.command,
      args: interpolateList(asStringList(entry.args, `${label}: server "${name}" args`)),
      env: interpolateRecord(asStringRecord(entry.env, `${label}: server "${name}" env`)),
    });
  }
  return out;
}

function asStringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as string[];
}

function asStringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${label} must be an object of strings`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new Error(`${label}.${k} must be a string`);
    out[k] = v;
  }
  return out;
}

/** `${VAR}` -> process.env.VAR, or empty string with a warning left to the caller. */
export function interpolate(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? '');
}

function interpolateList(list: string[]): string[] {
  return list.map((v) => interpolate(v));
}

function interpolateRecord(rec: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = interpolate(v);
  return out;
}
