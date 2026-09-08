#!/usr/bin/env node
/**
 * `hc` entry point.
 *
 * Phase 1 scope: routing and provider plumbing, exercised end to end against a
 * real endpoint. The agent loop, permissions and the TUI land in later phases;
 * the command surface here is the scaffold they hang off.
 */

import { Command } from 'commander';

import {
  AGENT_DIR,
  BUILTIN_PROVIDERS,
  ProviderError,
  ProviderRegistry,
  VERSION,
  builtinTools,
  discoverAgents,
  discoverSkills,
  FileOAuthStore,
  findProjectRoot,
  listTraceIds,
  loadMcpConfig,
  loadSettings,
  loginToServer,
  McpHub,
  readTrace,
  resolveBudgets,
  rollupStats,
  serveOverStdio,
  summarizeTrace,
} from '@harness-code/core';
import type {
  AgentSessionConfig,
  ModelRequest,
  PermissionMode,
  TraceSummary,
} from '@harness-code/core';
import { readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import { buildPrompt, decideFrontend, readStdin } from './dispatch.js';
import { printUsage } from './format.js';
import { runOneshot } from './oneshot.js';
import { createSink } from './output.js';
import type { TextSink } from './output.js';
import { runRepl } from './repl.js';
import { renderStats, renderTimeline } from './telemetry-view.js';

/**
 * Minimal `.env` loader: `KEY=value` per line, `#` comments, optional quotes.
 * Hand-rolled instead of pulling in `dotenv` — the format is small and this
 * avoids one more dependency for something this simple. Variables already
 * present in the real environment win, matching the usual dotenv convention:
 * `.env` is a convenience default, not an override.
 */
function loadDotEnv(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return; // no .env file; that is the normal case, not an error
  }
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '' && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv(resolvePath(process.cwd(), '.env'));

const program = new Command();

program
  .name('hc')
  .description('harness-code: a coding agent you can read all of')
  .version(VERSION, '-v, --version');

program
  .command('models', { isDefault: false })
  .description('List configured endpoints and whether credentials are present')
  .action(async () => {
    const { settings, sources } = await loadSettings();
    const registry = new ProviderRegistry({ settings });

    console.log(`default model: ${settings.model ?? '(unset)'}`);
    if (sources.length > 0) console.log(`settings: ${sources.join(', ')}`);
    console.log('');

    const rows = registry.list().map((id) => {
      let baseUrl = '(no base url)';
      let status: string;
      try {
        baseUrl = registry.config(id).baseUrl;
        registry.resolve(`${id}/probe`);
        status = 'ready';
      } catch (err) {
        status = err instanceof ProviderError && err.kind === 'auth' ? 'no key' : 'error';
      }
      const known = BUILTIN_PROVIDERS[id] ? '' : ' (custom)';
      return { id: id + known, status, baseUrl };
    });

    const width = Math.max(...rows.map((r) => r.id.length));
    for (const row of rows) {
      const mark = row.status === 'ready' ? '✓' : '·';
      console.log(`${mark} ${row.id.padEnd(width)}  ${row.status.padEnd(7)}  ${row.baseUrl}`);
    }
  });

program
  .command('raw')
  .description('Send one prompt straight to a model — no tools, no agent loop')
  .argument('<prompt>', 'the prompt to send')
  .option('-m, --model <ref>', 'provider/model, e.g. deepseek/deepseek-v4-flash')
  .option('--no-stream', 'wait for the whole response instead of streaming')
  .option('--json', 'print the raw response object instead of text')
  .action(async (prompt: string, opts: { model?: string; stream: boolean; json?: boolean }) => {
    const { settings } = await loadSettings();
    const ref = opts.model ?? settings.model;
    if (!ref) {
      fail('No model configured. Pass --model, or set "model" in .agent/settings.json.');
    }

    const registry = new ProviderRegistry({ settings });
    const resolved = registry.resolve(ref);

    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());

    const request: ModelRequest = {
      model: resolved.model,
      system: [{ id: 'identity', text: 'You are a concise, precise coding assistant.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      signal: controller.signal,
      ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
    };

    if (!opts.stream || opts.json) {
      const res = await resolved.provider.complete(request);
      if (opts.json) console.log(JSON.stringify(res, null, 2));
      else {
        for (const block of res.content) {
          if (block.type === 'text') process.stdout.write(block.text);
        }
        process.stdout.write('\n');
      }
      printUsage(resolved.ref, res.usage, res.latencyMs, res.ttftMs);
      return;
    }

    let thinkingOpen = false;
    for await (const ev of resolved.provider.stream(request)) {
      switch (ev.type) {
        case 'thinking_delta':
          if (!thinkingOpen) {
            process.stderr.write('\x1b[2m[thinking] ');
            thinkingOpen = true;
          }
          process.stderr.write(ev.text);
          break;
        case 'text_delta':
          if (thinkingOpen) {
            process.stderr.write('\x1b[0m\n');
            thinkingOpen = false;
          }
          process.stdout.write(ev.text);
          break;
        case 'tool_use_end':
          process.stdout.write(
            `\n[tool_use ${ev.block.name}] ${JSON.stringify(ev.block.input)}\n`,
          );
          break;
        case 'message_end':
          process.stdout.write('\n');
          printUsage(resolved.ref, ev.response.usage, ev.response.latencyMs, ev.response.ttftMs);
          break;
        default:
          break;
      }
    }
  });

program
  .command('agent', { isDefault: true })
  .description(
    'Run the agent loop with tools (read/write/edit/glob/grep/bash/todo). ' +
      'Omit <prompt> to start an interactive session — this is also what bare `hc` runs.',
  )
  .argument('[prompt]', 'the task to hand to the agent; omit to start an interactive session')
  .option('-m, --model <ref>', 'provider/model, e.g. deepseek/deepseek-v4-flash')
  .option('--cwd <dir>', 'workspace root the agent operates in', process.cwd())
  .option('--max-turns <n>', 'stop after this many turns', (v) => parseInt(v, 10))
  .option('--max-cost <usd>', 'stop once estimated cost exceeds this', (v) => parseFloat(v))
  .option('--max-tokens <n>', 'stop once cumulative input+output tokens exceed this', (v) => parseInt(v, 10))
  .option('--resume <id>', 'continue a previous session by id')
  .option(
    '--mode <mode>',
    'permission mode: ask|plan|acceptEdits|readOnly|yolo (overrides settings.json)',
  )
  .option('--allow <rule>', 'add an allow rule, e.g. "Bash(git status:*)" (repeatable)', collect, [])
  .option('--ask <rule>', 'add an ask rule (repeatable)', collect, [])
  .option('--deny <rule>', 'add a deny rule (repeatable)', collect, [])
  .option('-p, --print', 'force non-interactive one-shot; never enter the TUI/REPL')
  .option('--output-format <format>', 'text|json|stream-json (json/stream-json imply -p)', 'text')
  .option('--no-compact', 'disable automatic context compaction (history is never summarized)')
  .option('--no-skills', 'do not discover or offer skills')
  .option('--no-subagents', 'do not discover sub-agents or offer the task tool')
  .option('--no-mcp', 'skip MCP discovery entirely')
  .option('--no-trace', 'do not write a telemetry trace under .agent/traces for this run')
  .action(
    async (
      prompt: string | undefined,
      opts: {
        model?: string;
        cwd: string;
        maxTurns?: number;
        maxCost?: number;
        maxTokens?: number;
        resume?: string;
        mode?: PermissionMode;
        allow: string[];
        ask: string[];
        deny: string[];
        print: boolean;
        outputFormat: 'text' | 'json' | 'stream-json';
        compact: boolean;
        skills: boolean;
        subagents: boolean;
        mcp: boolean;
        trace: boolean;
      },
    ) => {
      const cwd = resolvePath(opts.cwd);
      const { settings } = await loadSettings(cwd);
      const ref = opts.model ?? settings.model;
      if (!ref) {
        fail('No model configured. Pass --model, or set "model" in .agent/settings.json.');
      }

      const registry = new ProviderRegistry({ settings });
      const resolved = registry.resolve(ref);
      const budgets = resolveBudgets(
        {
          maxTurns: opts.maxTurns,
          maxCost: opts.maxCost,
          maxTokens: opts.maxTokens,
          noCompact: !opts.compact,
        },
        settings,
      );

      const frontend = decideFrontend({
        hasPromptArg: prompt !== undefined,
        print: opts.print,
        outputFormat: opts.outputFormat,
        stdinIsTty: process.stdin.isTTY,
        stdoutIsTty: process.stdout.isTTY,
        env: process.env,
      });
      const stdin = await readStdin();
      const effectivePrompt = buildPrompt(prompt, stdin);

      const config: AgentSessionConfig = {
        cwd,
        model: resolved,
        ...(settings.smallModel ? { summarizerModel: registry.resolve(settings.smallModel) } : {}),
        settings,
        budgets,
        ...(opts.mode ? { mode: opts.mode } : {}),
        allow: opts.allow,
        ask: opts.ask,
        deny: opts.deny,
        skills: opts.skills,
        subagents: opts.subagents,
        compact: opts.compact,
        mcp: opts.mcp,
        trace: opts.trace,
        ...(opts.resume ? { resumeId: opts.resume } : {}),
      };

      if (frontend === 'tui') {
        try {
          const tui = (await import('@harness-code/tui')) as {
            runTui?: (config: AgentSessionConfig) => Promise<void>;
          };
          if (tui.runTui) {
            await tui.runTui(config);
            return;
          }
        } catch {
          // TUI unavailable (missing deps / not yet built) — fall back to the REPL.
        }
      }

      const sink = createSink(opts.outputFormat, resolved.ref);
      if (frontend === 'oneshot') {
        if (effectivePrompt === undefined) fail('no prompt given (and stdin was empty)');
        const interactive = process.stdin.isTTY && opts.outputFormat === 'text' && !opts.print;
        await runOneshot({ config, prompt: effectivePrompt, sink, interactive });
        return;
      }
      await runRepl(config, sink as TextSink);
    },
  );

const mcp = program.command('mcp').description('Model Context Protocol: connect servers, or expose this tool as one');

mcp
  .command('list')
  .description('Show configured MCP servers and the tools they expose')
  .option('--cwd <dir>', 'workspace root to resolve .mcp.json against', process.cwd())
  .action(async (opts: { cwd: string }) => {
    const cwd = resolvePath(opts.cwd);
    const { servers, sources } = await loadMcpConfig(cwd);
    if (sources.length > 0) console.log(`config: ${sources.join(', ')}`);
    if (servers.length === 0) {
      console.log('no MCP servers configured (.mcp.json not found or empty)');
      return;
    }
    const hub = new McpHub(servers);
    const specs = await hub.toolSpecs();
    for (const s of hub.status()) {
      const mark = s.state === 'ready' ? '✓' : s.state === 'failed' ? '✗' : '·';
      const server = servers.find((x) => x.name === s.name);
      let auth = '';
      if (server && server.transport !== 'stdio') {
        const hasStatic = Object.keys(server.headers).some((h) => h.toLowerCase() === 'authorization');
        const authed = (await new FileOAuthStore(server.url).tokens()) !== undefined;
        auth = hasStatic && server.auth !== 'oauth' ? '  [static token]' : authed ? '  [oauth ✓]' : '  [oauth — run: hc mcp login]';
      }
      console.log(
        `${mark} ${s.name} (${s.transport})  ${s.state}${auth}${s.error ? ` — ${s.error}` : ''}`,
      );
      for (const spec of specs.filter((t) => t.name.startsWith(`mcp__${s.name}__`))) {
        console.log(`    ${spec.name}`);
      }
    }
    await hub.closeAll();
  });

mcp
  .command('serve')
  .description('Expose the builtin tool set over MCP on stdio (for another agent or the inspector)')
  .action(async () => {
    process.stderr.write('\x1b[2mharness-code MCP server on stdio — builtin tools exposed\x1b[0m\n');
    await serveOverStdio({ tools: builtinTools() });
  });

mcp
  .command('login')
  .description('Authorize a remote (http/sse) MCP server via OAuth — opens a browser')
  .argument('<server>', 'server name from .mcp.json')
  .option('--cwd <dir>', 'workspace root to resolve .mcp.json against', process.cwd())
  .action(async (name: string, opts: { cwd: string }) => {
    const { servers } = await loadMcpConfig(resolvePath(opts.cwd));
    const server = servers.find((s) => s.name === name);
    if (!server) fail(`no MCP server named "${name}" in .mcp.json`);
    if (server.transport === 'stdio') {
      fail(`"${name}" is a stdio server — it does not use OAuth. Put credentials in its "env".`);
    }
    try {
      const { status } = await loginToServer(server);
      console.log(
        status === 'already-authorized'
          ? `✓ ${name} was already authorized`
          : `✓ authorized ${name}`,
      );
    } catch (err) {
      fail(`login failed: ${errorMessageOf(err)}`);
    }
  });

mcp
  .command('logout')
  .description('Forget cached OAuth tokens for a remote MCP server')
  .argument('<server>', 'server name from .mcp.json')
  .option('--cwd <dir>', 'workspace root to resolve .mcp.json against', process.cwd())
  .action(async (name: string, opts: { cwd: string }) => {
    const { servers } = await loadMcpConfig(resolvePath(opts.cwd));
    const server = servers.find((s) => s.name === name);
    if (!server || server.transport === 'stdio') fail(`no remote MCP server named "${name}"`);
    await new FileOAuthStore(server.url).clear();
    console.log(`✓ cleared cached credentials for ${name}`);
  });

program
  .command('skills')
  .description('List discovered skills (project, user, and builtin)')
  .option('--cwd <dir>', 'workspace root to resolve .agent/skills against', process.cwd())
  .action(async (opts: { cwd: string }) => {
    const cwd = resolvePath(opts.cwd);
    const { skills, counts } = await discoverSkills(cwd, {
      onSkip: (reason) => console.log(`· skipped ${reason}`),
    });
    if (skills.length === 0) {
      console.log('no skills found');
      return;
    }
    console.log(
      `${skills.length} skill${skills.length === 1 ? '' : 's'} ` +
        `(project ${counts.project}, user ${counts.user}, builtin ${counts.builtin})\n`,
    );
    for (const s of skills) {
      console.log(`${s.name}  [${s.source}]`);
      console.log(`  ${s.description}`);
      if (s.allowedTools) console.log(`  allowed-tools: ${s.allowedTools.join(' ')}`);
      console.log(`  ${s.dir}`);
    }
  });

program
  .command('agents')
  .description('List discovered sub-agents (project, user, and builtin)')
  .option('--cwd <dir>', 'workspace root to resolve .agent/agents against', process.cwd())
  .action(async (opts: { cwd: string }) => {
    const cwd = resolvePath(opts.cwd);
    const { agents, counts } = await discoverAgents(cwd, {
      onSkip: (reason) => console.log(`· skipped ${reason}`),
    });
    if (agents.length === 0) {
      console.log('no sub-agents found');
      return;
    }
    console.log(
      `${agents.length} sub-agent${agents.length === 1 ? '' : 's'} ` +
        `(project ${counts.project}, user ${counts.user}, builtin ${counts.builtin})\n`,
    );
    for (const a of agents) {
      console.log(`${a.name}  [${a.source}]`);
      console.log(`  ${a.description}`);
      console.log(`  tools: ${a.tools ? a.tools.join(' ') : '(inherits all builtin tools)'}`);
      if (a.model) console.log(`  model: ${a.model}`);
    }
  });

program
  .command('doctor')
  .description('Show what the harness thinks its configuration is')
  .action(async () => {
    const { settings, sources } = await loadSettings();
    console.log(JSON.stringify({ version: VERSION, sources, settings }, null, 2));
  });

program
  .command('trace')
  .description(
    'Replay a recorded session as a timeline: every model call and tool call with timing, tokens, and cost',
  )
  .argument('[id]', 'session id; defaults to the most recently written trace')
  .option('--cwd <dir>', 'workspace root to resolve .agent/traces against', process.cwd())
  .option('--json', 'emit the raw trace events as JSON instead of a timeline')
  .action(async (id: string | undefined, opts: { cwd: string; json?: boolean }) => {
    const agentDir = join(await findProjectRoot(resolvePath(opts.cwd)), AGENT_DIR);
    let resolvedId = id;
    if (!resolvedId) {
      const [newest] = await listTraceIds(agentDir);
      if (!newest) fail('no traces found under .agent/traces');
      resolvedId = newest.id;
    }
    let events;
    try {
      events = await readTrace(agentDir, resolvedId);
    } catch {
      fail(`no trace for session "${resolvedId}" (looked in ${join(agentDir, 'traces')})`);
    }
    if (opts.json) {
      console.log(JSON.stringify(events, null, 2));
      return;
    }
    console.log(renderTimeline(resolvedId, events));
  });

program
  .command('stats')
  .description('Aggregate token usage, cost, and turn counts across every recorded session')
  .option('--cwd <dir>', 'workspace root to resolve .agent/traces against', process.cwd())
  .option('--since <date>', 'only sessions started on or after this date (ISO, e.g. 2026-09-01)')
  .option('--json', 'emit the rollup as JSON')
  .action(async (opts: { cwd: string; since?: string; json?: boolean }) => {
    const agentDir = join(await findProjectRoot(resolvePath(opts.cwd)), AGENT_DIR);
    let sinceMs = 0;
    if (opts.since !== undefined) {
      sinceMs = Date.parse(opts.since);
      if (Number.isNaN(sinceMs)) fail(`--since: "${opts.since}" is not a recognisable date`);
    }
    const ids = await listTraceIds(agentDir);
    const summaries: TraceSummary[] = [];
    for (const { id } of ids) {
      try {
        const s = summarizeTrace(id, await readTrace(agentDir, id));
        if (s.startedAt >= sinceMs) summaries.push(s);
      } catch {
        // Unreadable or partial trace — leave it out of the totals.
      }
    }
    const rollup = rollupStats(summaries);
    console.log(opts.json ? JSON.stringify(rollup, null, 2) : renderStats(rollup));
  });

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fail(message: string): never {
  process.stderr.write(`hc: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof ProviderError) {
      process.stderr.write(`\nhc: ${err.message}\n`);
      if (err.detail) process.stderr.write(`\x1b[2m${err.detail}\x1b[0m\n`);
      process.exit(1);
    }
    throw err;
  }
}

void main();
