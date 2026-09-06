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
  AgentLoop,
  BUILTIN_PROVIDERS,
  ProviderError,
  ProviderRegistry,
  SessionRecorder,
  ToolRegistry,
  VERSION,
  builtinTools,
  createPermissionEngine,
  createPermissionHooks,
  findProjectRoot,
  loadSession,
  loadSettings,
  nonInteractiveAskHandler,
} from '@harness-code/core';
import type { AgentEvent, ModelRequest, PermissionMode } from '@harness-code/core';
import { readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

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
  .option('-m, --model <ref>', 'provider/model, e.g. deepseek/deepseek-chat')
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
  .command('agent')
  .description('Run the full agent loop with tools (read/write/edit/glob/grep/bash/todo)')
  .argument('<prompt>', 'the task to hand to the agent')
  .option('-m, --model <ref>', 'provider/model, e.g. deepseek/deepseek-chat')
  .option('--cwd <dir>', 'workspace root the agent operates in', process.cwd())
  .option('--max-turns <n>', 'stop after this many turns', (v) => parseInt(v, 10))
  .option('--max-cost <usd>', 'stop once estimated cost exceeds this', (v) => parseFloat(v))
  .option('--resume <id>', 'continue a previous session by id')
  .option(
    '--mode <mode>',
    'permission mode: ask|plan|acceptEdits|readOnly|yolo (overrides settings.json)',
  )
  .option('--allow <rule>', 'add an allow rule, e.g. "Bash(git status:*)" (repeatable)', collect, [])
  .option('--ask <rule>', 'add an ask rule (repeatable)', collect, [])
  .option('--deny <rule>', 'add a deny rule (repeatable)', collect, [])
  .action(
    async (
      prompt: string,
      opts: {
        model?: string;
        cwd: string;
        maxTurns?: number;
        maxCost?: number;
        resume?: string;
        mode?: PermissionMode;
        allow: string[];
        ask: string[];
        deny: string[];
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

      const agentDir = join(await findProjectRoot(cwd), AGENT_DIR);
      const recorder = new SessionRecorder(agentDir, opts.resume);
      const priorMessages = opts.resume ? await loadSession(agentDir, opts.resume) : [];

      const tools = new ToolRegistry(builtinTools());

      const permissions = settings.permissions ?? {};
      const mode: PermissionMode = opts.mode ?? permissions.mode ?? 'ask';
      const engine = createPermissionEngine({
        workspaceRoot: cwd,
        mode,
        allow: [...(permissions.allow ?? []), ...opts.allow],
        ask: [...(permissions.ask ?? []), ...opts.ask],
        deny: [...(permissions.deny ?? []), ...opts.deny],
      });
      // hc agent is a one-shot, non-interactive run: any "ask" verdict has nobody to ask,
      // so it must deterministically deny rather than hang or silently proceed.
      const hooks = createPermissionHooks(engine, nonInteractiveAskHandler);
      process.stderr.write(`\x1b[2mpermission mode: ${mode}\x1b[0m\n`);

      const controller = new AbortController();
      process.on('SIGINT', () => controller.abort());

      let thinkingOpen = false;
      const onEvent = (event: AgentEvent): void => {
        switch (event.type) {
          case 'thinking_delta':
            if (!thinkingOpen) {
              process.stderr.write('\x1b[2m[thinking] ');
              thinkingOpen = true;
            }
            process.stderr.write(event.text);
            break;
          case 'text_delta':
            if (thinkingOpen) {
              process.stderr.write('\x1b[0m\n');
              thinkingOpen = false;
            }
            process.stdout.write(event.text);
            break;
          case 'tool_call_start':
            process.stdout.write(`\n[tool_use ${event.name}] ${JSON.stringify(event.input)}\n`);
            break;
          case 'tool_call_end':
            if (event.result.isError) {
              process.stderr.write(`\x1b[31m[tool_error ${event.name}] ${event.result.content}\x1b[0m\n`);
            }
            break;
          default:
            break;
        }
      };

      const loop = new AgentLoop({
        model: resolved,
        tools,
        cwd,
        system: [{ id: 'identity', text: 'You are a concise, precise coding assistant.' }],
        recorder,
        hooks,
        signal: controller.signal,
        ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
        ...(opts.maxCost !== undefined ? { maxCostUSD: opts.maxCost } : {}),
        onEvent,
      });

      const userMessage = { role: 'user' as const, content: [{ type: 'text' as const, text: prompt }] };
      await recorder.recordMessage(userMessage);
      const result = await loop.run([...priorMessages, userMessage]);

      process.stdout.write('\n');
      printUsage(resolved.ref, result.usage);
      process.stderr.write(`\x1b[2msession ${recorder.id} · stop: ${result.stopReason}\x1b[0m\n`);
    },
  );

program
  .command('doctor')
  .description('Show what the harness thinks its configuration is')
  .action(async () => {
    const { settings, sources } = await loadSettings();
    console.log(JSON.stringify({ version: VERSION, sources, settings }, null, 2));
  });

function printUsage(
  ref: string,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; costUSD?: number; estimated?: boolean },
  latencyMs?: number,
  ttftMs?: number,
): void {
  const bits = [
    ref,
    `in ${usage.inputTokens}`,
    `out ${usage.outputTokens}`,
  ];
  if (usage.cachedInputTokens > 0) bits.push(`cached ${usage.cachedInputTokens}`);
  if (usage.costUSD !== undefined) bits.push(`$${usage.costUSD.toFixed(5)}`);
  if (ttftMs !== undefined) bits.push(`ttft ${ttftMs}ms`);
  if (latencyMs !== undefined) bits.push(`total ${latencyMs}ms`);
  if (usage.estimated) bits.push('(token counts estimated)');
  process.stderr.write(`\x1b[2m${bits.join('  ·  ')}\x1b[0m\n`);
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
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
