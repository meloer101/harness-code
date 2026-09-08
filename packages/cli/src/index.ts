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
  AGENT_CONVENTIONS,
  AGENT_DIR,
  AgentLoop,
  BUILTIN_PROVIDERS,
  ProviderError,
  ProviderRegistry,
  SessionRecorder,
  SessionState,
  ToolRegistry,
  VERSION,
  addUsage,
  buildAgentSystemPrompt,
  builtinTools,
  createCompactor,
  createPermissionEngine,
  createPermissionHooks,
  buildSubagentSystemPrompt,
  createSkillTool,
  createTaskTool,
  discoverAgents,
  discoverSkills,
  exitPlanModeTool,
  findProjectRoot,
  isSandboxExecAvailable,
  FileOAuthStore,
  loadMcpConfig,
  loadProjectMemory,
  loadSession,
  loadSettings,
  loginToServer,
  McpHub,
  mergeHooks,
  narrowToolSpecs,
  nonInteractiveAskHandler,
  runSubagent,
  subagentToolSpecs,
  SkillCatalog,
  rebuildSessionState,
  resolveResources,
  rollupStats,
  serveOverStdio,
  summarizeTrace,
  TraceRecorder,
  listTraceIds,
  readTrace,
} from '@harness-code/core';
import type {
  ActiveSkill,
  AgentControl,
  AgentEvent,
  AskHandler,
  Message,
  ModelRequest,
  PermissionMode,
  TraceSummary,
  Usage,
} from '@harness-code/core';
import { resolveBudgets } from './budgets.js';
import { cacheSummary, describeStop, fmtBreakdown, fmtTokens, printUsage } from './format.js';
import type { ContextSnapshot } from './format.js';
import { renderStats, renderTimeline } from './telemetry-view.js';
import { createPrompter, interactiveAskHandler } from './prompter.js';
import type { Prompter } from './prompter.js';
import { readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';

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
  .option('--no-compact', 'disable automatic context compaction (history is never summarized)')
  .option('--no-skills', 'do not discover or offer skills')
  .option('--no-subagents', 'do not discover sub-agents or offer the task tool')
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
        compact: boolean;
        skills: boolean;
        subagents: boolean;
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

      // AGENTS.md / CLAUDE.md from the project root down to cwd (+ ~/.agent).
      // Loaded once — it does not change across turns.
      const memory = await loadProjectMemory(cwd);
      if (memory.sources.length > 0) {
        const rel = memory.sources.map((s) => resolvePath(s).replace(`${cwd}/`, ''));
        process.stderr.write(`\x1b[2mproject memory: ${rel.join(', ')}\x1b[0m\n`);
      }

      // Skills from .agent/skills (project + ~/.agent) plus the builtins. Only
      // name+description reach the system prompt now; the `skill` tool loads a
      // body on demand.
      const { skills: discoveredSkills, counts: skillCounts } = opts.skills
        ? await discoverSkills(cwd, {
            onSkip: (reason) => process.stderr.write(`\x1b[2mskipped ${reason}\x1b[0m\n`),
          })
        : { skills: [], counts: { project: 0, user: 0, builtin: 0 } };
      const skillCatalog = new SkillCatalog(discoveredSkills);
      if (skillCatalog.size > 0) {
        process.stderr.write(
          `\x1b[2mskills: ${skillCatalog.size} discovered ` +
            `(project ${skillCounts.project}, user ${skillCounts.user}, builtin ${skillCounts.builtin})` +
            (skillCatalog.dropped.length > 0
              ? ` — ${skillCatalog.dropped.length} not advertised (manifest budget)`
              : '') +
            `\x1b[0m\n`,
        );
      }

      // Sub-agents from .agent/agents (project + ~/.agent) plus the builtins.
      // Dispatched via the `task` tool; each runs in its own context window.
      const { agents: discoveredAgents } = opts.subagents
        ? await discoverAgents(cwd, {
            onSkip: (reason) => process.stderr.write(`\x1b[2mskipped ${reason}\x1b[0m\n`),
          })
        : { agents: [] };
      if (discoveredAgents.length > 0) {
        process.stderr.write(
          `\x1b[2magents: ${discoveredAgents.length} available ` +
            `(${discoveredAgents.map((a) => a.name).join(', ')})\x1b[0m\n`,
        );
      }

      // MCP servers from .mcp.json (project + ~/.agent). Connections are lazy —
      // `hub.toolSpecs()` below is what actually spawns them, and a server that
      // fails to connect just contributes no tools.
      const mcpConfig = await loadMcpConfig(cwd);
      const hub = new McpHub(mcpConfig.servers);
      const mcpToolSpecs = hub.empty ? [] : await hub.toolSpecs();
      if (!hub.empty) {
        const s = hub.status();
        const ok = s.filter((x) => x.state === 'ready');
        const failed = s.filter((x) => x.state === 'failed');
        process.stderr.write(
          `\x1b[2mmcp: ${ok.length}/${s.length} server${s.length === 1 ? '' : 's'} ready, ` +
            `${mcpToolSpecs.length} tool${mcpToolSpecs.length === 1 ? '' : 's'}` +
            (failed.length > 0
              ? ` — unavailable: ${failed.map((x) => `${x.name} (${x.error ?? 'failed'})`).join(', ')}`
              : '') +
            `\x1b[0m\n`,
        );
      }
      // MCP prompts become `/name` (or `/server:name` on collision) commands in
      // the REPL. Keyed both ways so either form resolves.
      const mcpPrompts = new Map<string, { server: string; name: string }>();
      if (!hub.empty) {
        for (const { server, prompt } of await hub.prompts()) {
          const ref = { server, name: prompt.name };
          mcpPrompts.set(`${server}:${prompt.name}`, ref);
          if (!mcpPrompts.has(prompt.name)) mcpPrompts.set(prompt.name, ref);
        }
      }
      const closeHub = (): Promise<void> => hub.closeAll();

      const agentDir = join(await findProjectRoot(cwd), AGENT_DIR);
      const recorder = new SessionRecorder(agentDir, opts.resume);
      // Telemetry trace: on by default, off with --no-trace or settings.telemetry.enabled=false.
      // Same id as the session so `hc trace <id>` / `hc stats` line up with `--resume <id>`.
      const traceOn = opts.trace !== false && settings.telemetry?.enabled !== false;
      const trace = traceOn ? new TraceRecorder(agentDir, recorder.id) : undefined;
      const priorMessages = opts.resume ? await loadSession(agentDir, opts.resume) : [];
      // Resuming replays the read ledger too, not just the messages — otherwise a file
      // read in the prior run looks unread to this one, and the first edit attempt
      // trips the read-before-edit invariant for no reason. This same SessionState is
      // reused across every turn below (one-shot has only one; the REPL has many) — it's
      // what makes the read ledger persist across an entire interactive session instead
      // of resetting on every message.
      const session = opts.resume ? await rebuildSessionState(agentDir, opts.resume, cwd) : new SessionState();

      const permissions = settings.permissions ?? {};
      const mode: PermissionMode = opts.mode ?? permissions.mode ?? 'ask';
      const engine = createPermissionEngine({
        workspaceRoot: cwd,
        mode,
        allow: [...(permissions.allow ?? []), ...opts.allow],
        ask: [...(permissions.ask ?? []), ...opts.ask],
        deny: [...(permissions.deny ?? []), ...opts.deny],
      });

      // The REPL assigns this before the first turn runs; one-shot leaves it
      // undefined and the prompter makes its own readline on demand.
      let sharedRl: Interface | undefined;
      let prompter: Prompter | undefined;
      const getPrompter = (): Prompter => (prompter ??= createPrompter(sharedRl));

      // Flush a half-open dim [thinking] block before a prompt, so the question
      // doesn't inherit the grey escape. Reassigned once `onEvent` is defined.
      let flushThinking = (): void => {};

      // With a REPL (f63eb8c) there is now a human present to answer an "ask"
      // verdict — but only when stdin is a TTY. Piped / CI input keeps the
      // deterministic deny so scripted runs stay scriptable.
      const interactiveAsk: AskHandler = (req) =>
        interactiveAskHandler(engine, getPrompter(), {
          onBeforePrompt: () => flushThinking(),
          echo: (line) => process.stderr.write(`\x1b[2m${line}\x1b[0m\n`),
        })(req);
      const askHandler: AskHandler = process.stdin.isTTY ? interactiveAsk : nonInteractiveAskHandler;
      process.stderr.write(`\x1b[2mpermission mode: ${mode}\x1b[0m\n`);

      const planApprovedMode: PermissionMode = permissions.planApprovedMode ?? 'acceptEdits';
      // Skills the model has loaded this session. `buildLoop` reads this to
      // narrow the tool set when a loaded skill declared `allowed-tools`.
      const activeSkills: ActiveSkill[] = [];
      // Channel from exit_plan_mode / the skill tool back here. `mode` is read
      // live off the engine so the tool always sees the current mode.
      const control: AgentControl = {
        get mode(): PermissionMode {
          return engine.getMode();
        },
        get activeSkills(): readonly ActiveSkill[] {
          return activeSkills;
        },
        activateSkill(skill: ActiveSkill): void {
          if (activeSkills.some((s) => s.name === skill.name)) return;
          activeSkills.push(skill);
          process.stderr.write(
            `\x1b[2mskill loaded: ${skill.name}` +
              (skill.allowedTools ? ` — tools now limited to: ${skill.allowedTools.join(' ')}` : '') +
              `\x1b[0m\n`,
          );
        },
        exitPlanMode(): PermissionMode {
          engine.setMode(planApprovedMode);
          process.stderr.write(`\x1b[2mmode: plan → ${planApprovedMode}\x1b[0m\n`);
          return planApprovedMode;
        },
        ...(process.stdin.isTTY
          ? {
              confirm: async ({ title, body }: { title: string; body: string }) => {
                flushThinking();
                return getPrompter().approve({ title, body });
              },
            }
          : {}),
      };
      if (!isSandboxExecAvailable()) {
        process.stderr.write(
          '\x1b[2mbash sandbox: unavailable — commands run without OS-level workspace confinement ' +
            '(sandbox-exec is macOS-only); the permission engine\'s review is still in effect.\x1b[0m\n',
        );
      }

      const {
        maxTurns,
        maxCostUSD,
        maxTokens,
        maxOutputTokens,
        temperature,
        contextCompactRatio,
        compactKeepTurns,
        subagentMaxTurns: subagentMaxTurnsSetting,
      } =
        resolveBudgets(
          {
            maxTurns: opts.maxTurns,
            maxCost: opts.maxCost,
            maxTokens: opts.maxTokens,
            noCompact: !opts.compact,
          },
          settings,
        );

      // Compaction: mechanism after Claude Code (threshold → summarize the oldest
      // span → continue), digest content after Manus (task state *plus* the
      // working-style memo). Summaries run on the main model unless settings pin
      // a cheaper `smallModel`. Failures are swallowed to a stderr line — the
      // loop's `context_limit` stop is still the backstop.
      const summarizer = settings.smallModel ? registry.resolve(settings.smallModel) : resolved;
      const compactHook =
        opts.compact === false
          ? undefined
          : {
              onCompact: createCompactor({
                provider: summarizer.provider,
                model: summarizer.model,
                conventions: AGENT_CONVENTIONS,
                ...(compactKeepTurns !== undefined ? { keepTurns: compactKeepTurns } : {}),
                onSkip: (reason) => process.stderr.write(`\x1b[2m${reason}\x1b[0m\n`),
              }),
            };
      const hooks = mergeHooks(createPermissionHooks(engine, askHandler), compactHook);

      // The `task` tool: dispatch a sub-agent in its own context window. The run
      // itself is a closure over the host's registry / engine / settings — the
      // child inherits the parent's permission rules verbatim (so it can never
      // escalate), gets its tool set narrowed to the agent def's `tools` (minus
      // `task` — no recursion), and always uses the deny-on-ask handler since
      // there is no human in a sub-agent loop.
      const subagentMaxTurns = subagentMaxTurnsSetting ?? 20;
      const taskTool =
        discoveredAgents.length > 0
          ? createTaskTool({
              agents: discoveredAgents,
              async run(def, subPrompt, runCtx) {
                const childModel = def.model ? registry.resolve(def.model) : resolved;
                const childEngine = createPermissionEngine({
                  workspaceRoot: cwd,
                  mode: engine.getMode(),
                  allow: [...(permissions.allow ?? []), ...opts.allow],
                  ask: [...(permissions.ask ?? []), ...opts.ask],
                  deny: [...(permissions.deny ?? []), ...opts.deny],
                });
                const childTools = subagentToolSpecs(builtinTools(), def);
                process.stderr.write(`\x1b[2m  ⤷ ${def.name}: dispatched\x1b[0m\n`);
                const result = await runSubagent({
                  model: childModel,
                  tools: childTools,
                  system: buildSubagentSystemPrompt({
                    cwd,
                    role: def.body,
                    ...(memory.text ? { projectMemory: memory.text } : {}),
                  }),
                  hooks: mergeHooks(
                    createPermissionHooks(childEngine, nonInteractiveAskHandler),
                    compactHook,
                  ),
                  cwd,
                  prompt: subPrompt,
                  maxTurns: subagentMaxTurns,
                  ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
                  ...(temperature !== undefined ? { temperature } : {}),
                  ...(contextCompactRatio !== undefined ? { contextCompactRatio } : {}),
                  ...(runCtx.signal ? { signal: runCtx.signal } : {}),
                  onEvent: (ev) => {
                    if (ev.type === 'tool_call_start') {
                      process.stderr.write(
                        `\x1b[2m  ⤷ ${def.name}: ${ev.name} ${JSON.stringify(ev.input)}\x1b[0m\n`,
                      );
                    }
                  },
                });
                process.stderr.write(
                  `\x1b[2m  ⤷ ${def.name}: done (${result.turns} turn${result.turns === 1 ? '' : 's'}, ` +
                    `${fmtTokens(result.usage.inputTokens + result.usage.outputTokens)} tokens)\x1b[0m\n`,
                );
                sessionUsage = sessionUsage ? addUsage(sessionUsage, result.usage) : result.usage;
                await trace?.append({
                  type: 'subagent',
                  ts: Date.now(),
                  turn: 0,
                  name: def.name,
                  turns: result.turns,
                  inputTokens: result.usage.inputTokens,
                  outputTokens: result.usage.outputTokens,
                  cachedInputTokens: result.usage.cachedInputTokens,
                  ...(result.usage.costUSD !== undefined ? { costUSD: result.usage.costUSD } : {}),
                  stopReason: result.stopReason,
                });
                return result;
              },
            })
          : undefined;

      let lastContext: ContextSnapshot | undefined;
      let contextWarned = false;
      // Cumulative across every turn of this session (each AgentLoop.run() resets
      // its own counter), for the cache-hit-rate summary at the end.
      let sessionUsage: Usage | undefined;

      let thinkingOpen = false;
      const closeThinking = (): void => {
        if (thinkingOpen) {
          process.stderr.write('\x1b[0m\n');
          thinkingOpen = false;
        }
      };
      flushThinking = closeThinking;
      const onEvent = (event: AgentEvent): void => {
        switch (event.type) {
          case 'context': {
            lastContext = event;
            if (event.ratio >= 0.8 && !contextWarned) {
              contextWarned = true;
              closeThinking();
              process.stderr.write(
                `\x1b[33mcontext ${fmtTokens(event.usedTokens)}/${fmtTokens(event.windowTokens)} ` +
                  `(${Math.round(event.ratio * 100)}%) [${fmtBreakdown(event.breakdown)}] — approaching the window limit. ` +
                  `History is compacted automatically near ~92%${opts.compact === false ? ' (disabled by --no-compact)' : ''}.\x1b[0m\n`,
              );
            }
            break;
          }
          case 'compaction':
            closeThinking();
            process.stderr.write(
              `\x1b[2mcontext compacted: ${fmtTokens(event.tokensBefore)} → ${fmtTokens(event.tokensAfter)} tokens ` +
                `(kept last ${event.keptTurns} turn${event.keptTurns === 1 ? '' : 's'})\x1b[0m\n`,
            );
            break;
          case 'thinking_delta':
            if (!thinkingOpen) {
              process.stderr.write('\x1b[2m[thinking] ');
              thinkingOpen = true;
            }
            process.stderr.write(event.text);
            break;
          case 'text_delta':
            closeThinking();
            process.stdout.write(event.text);
            break;
          case 'tool_call_start':
            process.stdout.write(`\n[tool_use ${event.name}] ${JSON.stringify(event.input)}\n`);
            break;
          case 'tool_call_end':
            if (event.result.isError) {
              process.stderr.write(`\x1b[31m[tool_error ${event.name}] ${event.result.content}\x1b[0m\n`);
            } else if (event.name === 'exit_plan_mode') {
              closeThinking();
              process.stderr.write(`\x1b[2m${event.result.content}\x1b[0m\n`);
            } else if (event.name === 'task') {
              closeThinking();
              process.stderr.write(`\x1b[2m  ⤷ report:\x1b[0m\n`);
              process.stderr.write(
                event.result.content
                  .split('\n')
                  .map((l) => `\x1b[2m  │ ${l}\x1b[0m`)
                  .join('\n') + '\n',
              );
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
      // `tools` and `system` are also rebuilt here, per the *current* engine mode:
      // exit_plan_mode is only offered in plan mode, and the prompt overlay only
      // appears there — so once a plan is approved the next turn drops both.
      function buildLoop(signal: AbortSignal): AgentLoop {
        const activeMode = engine.getMode();
        const specs = [
          ...builtinTools(),
          ...(activeMode === 'plan' ? [exitPlanModeTool] : []),
          ...(skillCatalog.size > 0 ? [createSkillTool(skillCatalog)] : []),
          ...(taskTool ? [taskTool] : []),
          ...mcpToolSpecs,
        ];
        // A loaded skill's `allowed-tools` narrows what the model sees next turn.
        const narrowed = narrowToolSpecs(specs, activeSkills);
        return new AgentLoop({
          model: resolved,
          tools: new ToolRegistry(narrowed),
          cwd,
          system: buildAgentSystemPrompt({
            cwd,
            mode: activeMode,
            ...(memory.text ? { projectMemory: memory.text } : {}),
            ...(skillCatalog.manifest() ? { skillsManifest: skillCatalog.manifest() } : {}),
          }),
          recorder,
          ...(trace ? { trace } : {}),
          session,
          hooks,
          control,
          signal,
          ...(maxTurns !== undefined ? { maxTurns } : {}),
          ...(contextCompactRatio !== undefined ? { contextCompactRatio } : {}),
          ...(maxCostUSD !== undefined ? { maxCostUSD } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          onEvent,
        });
      }

      async function runOneTurn(text: string, messages: Message[]) {
        let effectiveText = text;
        if (!hub.empty) {
          const { context, notes } = await resolveResources(hub, text);
          for (const n of notes) process.stderr.write(`\x1b[2m@resource ${n}\x1b[0m\n`);
          if (context.length > 0) effectiveText = `${context.join('\n\n')}\n\n${text}`;
        }
        const controller = new AbortController();
        const onSigint = (): void => controller.abort();
        process.on('SIGINT', onSigint);
        try {
          const userMessage = {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: effectiveText }],
          };
          await recorder.recordMessage(userMessage);
          const startedAt = Date.now();
          await trace?.append({
            type: 'run_start',
            ts: startedAt,
            sessionId: recorder.id,
            model: resolved.ref,
            cwd,
            mode: engine.getMode(),
            resumed: opts.resume !== undefined,
          });
          const result = await buildLoop(controller.signal).run([...messages, userMessage]);
          await trace?.append({
            type: 'run_end',
            ts: Date.now(),
            stopReason: result.stopReason,
            turns: result.turns,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            cachedInputTokens: result.usage.cachedInputTokens,
            ...(result.usage.costUSD !== undefined ? { costUSD: result.usage.costUSD } : {}),
            wallMs: Date.now() - startedAt,
          });
          process.stdout.write('\n');
          printUsage(resolved.ref, result.usage, undefined, undefined, lastContext);
          sessionUsage = sessionUsage ? addUsage(sessionUsage, result.usage) : result.usage;
          const note = describeStop(result.stopReason);
          if (note) process.stderr.write(`\x1b[2m${note}\x1b[0m\n`);
          return result;
        } finally {
          process.off('SIGINT', onSigint);
        }
      }

      if (prompt !== undefined) {
        try {
          const result = await runOneTurn(prompt, priorMessages);
          process.stderr.write(
            `\x1b[2msession ${recorder.id} · stop: ${result.stopReason}${cacheSummary(sessionUsage)}\x1b[0m\n`,
          );
        } finally {
          prompter?.close(); // no-op unless an interactive prompt made its own readline
          await closeHub();
        }
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
      // The interactive ask handler borrows this rl: rl.question() intercepts the
      // next line without emitting 'line', so it doesn't fight the queue below.
      sharedRl = rl;

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
        let turnText = text;
        if (text.startsWith('/')) {
          const [cmd, ...rest] = text.slice(1).split(/\s+/);
          const ref = cmd ? mcpPrompts.get(cmd) : undefined;
          if (!ref) {
            process.stderr.write(
              `\x1b[2munknown command "/${cmd}". MCP prompts available: ${
                mcpPrompts.size > 0 ? [...new Set([...mcpPrompts.values()].map((p) => p.name))].join(', ') : '(none)'
              }\x1b[0m\n`,
            );
            rl.prompt();
            return;
          }
          try {
            const conn = hub.connection(ref.server);
            const body = await conn?.getPrompt(ref.name, rest.length > 0 ? { input: rest.join(' ') } : {});
            if (!body) {
              process.stderr.write(`\x1b[2mprompt "${ref.name}" returned nothing\x1b[0m\n`);
              rl.prompt();
              return;
            }
            turnText = body;
            process.stderr.write(`\x1b[2m/${cmd} → ${body.length} chars from ${ref.server}\x1b[0m\n`);
          } catch (err) {
            process.stderr.write(`\x1b[31m/${cmd}: ${errorMessageOf(err)}\x1b[0m\n`);
            rl.prompt();
            return;
          }
        }
        process.off('SIGINT', onIdleSigint);
        try {
          const result = await runOneTurn(turnText, messages);
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
        void queue
          .finally(() => closeHub())
          .finally(() => {
            process.stderr.write(`\n\x1b[2msession ${recorder.id}${cacheSummary(sessionUsage)}\x1b[0m\n`);
            process.exit(0);
          });
      });
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
