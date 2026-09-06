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
  SessionState,
  ToolRegistry,
  VERSION,
  buildAgentSystemPrompt,
  builtinTools,
  createPermissionEngine,
  createPermissionHooks,
  findProjectRoot,
  isSandboxExecAvailable,
  loadSession,
  loadSettings,
  nonInteractiveAskHandler,
  rebuildSessionState,
} from '@harness-code/core';
import type { AgentEvent, Message, ModelRequest, PermissionMode } from '@harness-code/core';
import { resolveBudgets } from './budgets.js';
import { readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';

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
  .command('agent', { isDefault: true })
  .description(
    'Run the agent loop with tools (read/write/edit/glob/grep/bash/todo). ' +
      'Omit <prompt> to start an interactive session — this is also what bare `hc` runs.',
  )
  .argument('[prompt]', 'the task to hand to the agent; omit to start an interactive session')
  .option('-m, --model <ref>', 'provider/model, e.g. deepseek/deepseek-chat')
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
      // Resuming replays the read ledger too, not just the messages — otherwise a file
      // read in the prior run looks unread to this one, and the first edit attempt
      // trips the read-before-edit invariant for no reason. This same SessionState is
      // reused across every turn below (one-shot has only one; the REPL has many) — it's
      // what makes the read ledger persist across an entire interactive session instead
      // of resetting on every message.
      const session = opts.resume ? await rebuildSessionState(agentDir, opts.resume, cwd) : new SessionState();

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
      // Neither a one-shot run nor this REPL has anyone to answer an "ask" verdict
      // interactively (that needs Phase 9's TUI), so it must deterministically deny
      // rather than hang or silently proceed.
      const hooks = createPermissionHooks(engine, nonInteractiveAskHandler);
      process.stderr.write(`\x1b[2mpermission mode: ${mode}\x1b[0m\n`);
      if (!isSandboxExecAvailable()) {
        process.stderr.write(
          '\x1b[2mbash sandbox: unavailable — commands run without OS-level workspace confinement ' +
            '(sandbox-exec is macOS-only); the permission engine\'s review is still in effect.\x1b[0m\n',
        );
      }

      const { maxTurns, maxCostUSD, maxTokens, maxOutputTokens, temperature } = resolveBudgets(
        { maxTurns: opts.maxTurns, maxCost: opts.maxCost, maxTokens: opts.maxTokens },
        settings,
      );

      let lastContext: { usedTokens: number; windowTokens: number; ratio: number } | undefined;
      let contextWarned = false;

      let thinkingOpen = false;
      const onEvent = (event: AgentEvent): void => {
        switch (event.type) {
          case 'context': {
            lastContext = event;
            if (event.ratio >= 0.8 && !contextWarned) {
              contextWarned = true;
              if (thinkingOpen) {
                process.stderr.write('\x1b[0m\n');
                thinkingOpen = false;
              }
              process.stderr.write(
                `\x1b[33mcontext ${fmtTokens(event.usedTokens)}/${fmtTokens(event.windowTokens)} ` +
                  `(${Math.round(event.ratio * 100)}%) — approaching the window limit. ` +
                  `Start a new session to reset context (in-session /compact lands in Phase 4).\x1b[0m\n`,
              );
            }
            break;
          }
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

      // One AgentLoop per turn (cheap: it just stores references), all sharing the one
      // `session` above — that's what carries the read ledger across turns. The
      // AbortSignal is likewise per-turn: it's set at construction, so a single
      // long-lived loop could never get a fresh signal for message two onward, which
      // is what a mid-stream Ctrl+C needs to abort one turn without killing the REPL.
      function buildLoop(signal: AbortSignal): AgentLoop {
        return new AgentLoop({
          model: resolved,
          tools,
          cwd,
          system: buildAgentSystemPrompt({ cwd }),
          recorder,
          session,
          hooks,
          signal,
          ...(maxTurns !== undefined ? { maxTurns } : {}),
          ...(maxCostUSD !== undefined ? { maxCostUSD } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          onEvent,
        });
      }

      async function runOneTurn(text: string, messages: Message[]) {
        const controller = new AbortController();
        const onSigint = (): void => controller.abort();
        process.on('SIGINT', onSigint);
        try {
          const userMessage = { role: 'user' as const, content: [{ type: 'text' as const, text }] };
          await recorder.recordMessage(userMessage);
          const result = await buildLoop(controller.signal).run([...messages, userMessage]);
          process.stdout.write('\n');
          printUsage(resolved.ref, result.usage, undefined, undefined, lastContext);
          const note = describeStop(result.stopReason);
          if (note) process.stderr.write(`\x1b[2m${note}\x1b[0m\n`);
          return result;
        } finally {
          process.off('SIGINT', onSigint);
        }
      }

      if (prompt !== undefined) {
        const result = await runOneTurn(prompt, priorMessages);
        process.stderr.write(`\x1b[2msession ${recorder.id} · stop: ${result.stopReason}\x1b[0m\n`);
        return;
      }

      // Interactive session: plain text in, streamed response out, same as the one-shot
      // path above but looped over stdin instead of a single CLI argument.
      process.stderr.write(
        `\x1b[2msession ${recorder.id} · cwd ${cwd} · model ${resolved.ref} · mode ${mode}\x1b[0m\n`,
      );
      process.stderr.write('\x1b[2mtype a message, or "exit"/"quit" to leave (Ctrl+D also works)\x1b[0m\n');

      let messages = priorMessages;
      const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });

      // Ctrl+C while idle at the prompt closes the session; while a turn is running,
      // runOneTurn's own SIGINT listener (registered above) takes over instead — this
      // one is removed for the duration of the turn so only one of the two ever fires.
      const onIdleSigint = (): void => rl.close();
      process.on('SIGINT', onIdleSigint);

      // Piped/non-interactive input arrives as one buffered chunk, and readline fires
      // 'line' for every line already parsed out of it synchronously, back to back —
      // pause()/resume() only affects the *next* underlying read, not lines already
      // queued from the current one. Without this chain, a fast burst of input (a
      // script, or someone typing ahead) would start several turns concurrently and
      // could process "exit" before an earlier real message ever got a chance to run.
      // Chaining onto one promise instead makes every line wait for the previous one's
      // turn to fully finish, whether it arrived a second later or in the same chunk.
      let queue: Promise<void> = Promise.resolve();

      async function processLine(line: string): Promise<void> {
        const text = line.trim();
        if (text === '') {
          rl.prompt();
          return;
        }
        if (text === 'exit' || text === 'quit') {
          rl.close();
          return;
        }
        process.off('SIGINT', onIdleSigint);
        try {
          const result = await runOneTurn(text, messages);
          messages = result.messages;
        } catch (err) {
          process.stderr.write(`\x1b[31mhc: ${errorMessageOf(err)}\x1b[0m\n`);
        } finally {
          process.on('SIGINT', onIdleSigint);
          rl.prompt();
        }
      }

      rl.prompt();
      rl.on('line', (line) => {
        queue = queue.then(() => processLine(line));
      });

      rl.on('close', () => {
        void queue.finally(() => {
          process.stderr.write(`\n\x1b[2msession ${recorder.id}\x1b[0m\n`);
          process.exit(0);
        });
      });
    },
  );

program
  .command('doctor')
  .description('Show what the harness thinks its configuration is')
  .action(async () => {
    const { settings, sources } = await loadSettings();
    console.log(JSON.stringify({ version: VERSION, sources, settings }, null, 2));
  });

interface ContextSnapshot {
  usedTokens: number;
  windowTokens: number;
  ratio: number;
}

function printUsage(
  ref: string,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; costUSD?: number; estimated?: boolean },
  latencyMs?: number,
  ttftMs?: number,
  context?: ContextSnapshot,
): void {
  const bits = [
    ref,
    `in ${usage.inputTokens}`,
    `out ${usage.outputTokens}`,
  ];
  if (usage.cachedInputTokens > 0) bits.push(`cached ${usage.cachedInputTokens}`);
  if (usage.costUSD !== undefined) bits.push(`$${usage.costUSD.toFixed(5)}`);
  if (context) {
    bits.push(
      `ctx ${fmtTokens(context.usedTokens)}/${fmtTokens(context.windowTokens)} ` +
        `(${Math.round(context.ratio * 100)}%)`,
    );
  }
  if (ttftMs !== undefined) bits.push(`ttft ${ttftMs}ms`);
  if (latencyMs !== undefined) bits.push(`total ${latencyMs}ms`);
  if (usage.estimated) bits.push('(token counts estimated)');
  process.stderr.write(`\x1b[2m${bits.join('  ·  ')}\x1b[0m\n`);
}

/** `12345` -> `12.3k`; small counts stay exact. */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

/** A one-liner explaining why the loop stopped, for the reasons a user should act on. */
function describeStop(reason: string): string | undefined {
  switch (reason) {
    case 'context_limit':
      return 'stopped: context window nearly full. Start a new session to continue.';
    case 'max_tokens':
      return 'stopped: hit the --max-tokens budget (limit triggered after the turn that crossed it, not a hard ceiling).';
    case 'max_cost':
      return 'stopped: hit the --max-cost budget (limit triggered after the turn that crossed it, not a hard ceiling).';
    case 'max_turns':
      return 'stopped: hit the max-turns budget.';
    default:
      return undefined;
  }
}

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
