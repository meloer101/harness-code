/**
 * `AgentSession` — the stateful, multi-turn orchestrator.
 *
 * Three related objects, disambiguated:
 *
 *  - `SessionState` (`session.ts`) — the in-memory read ledger + todo list.
 *  - `SessionRecorder` (`session.ts`) — appends messages to the on-disk `.jsonl`.
 *  - `AgentSession` (this file) — the *live* orchestrator that owns the
 *    provider, permission engine, skills, sub-agents, MCP hub, compactor,
 *    recorder and trace, and runs turns on request.
 *
 * `AgentLoop` stays per-turn and stateless; this class is what turns it into a
 * multi-turn session the CLI (one-shot / REPL) and the TUI both drive through
 * the same renderer-agnostic surface. It deliberately never touches process
 * signals — SIGINT is 100% the frontend's job (`abort()` is the API here).
 */

import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import { resolveBudgets } from '../config/budgets.js';
import type { ResolvedBudgets } from '../config/budgets.js';
import { AGENT_DIR, findProjectRoot } from '../config/settings.js';
import type { Settings } from '../config/settings.js';
import { createCompactor } from '../context/compactor.js';
import { loadProjectMemory } from '../context/memory.js';
import type { ProjectMemory } from '../context/memory.js';
import { estimateRequestTokens } from '../context/tokenizer.js';
import { fmtBreakdown, fmtTokens } from '../util/format.js';
import {
  createPermissionEngine,
  createPermissionHooks,
  isSandboxExecAvailable,
  nonInteractiveAskHandler,
} from '../permissions/index.js';
import type {
  AskHandler,
  PermissionEngine,
  PermissionMode,
} from '../permissions/index.js';
import { builtinTools, exitPlanModeTool } from '../tools/index.js';
import { ToolRegistry } from '../tools/registry.js';
import type { AnyToolSpec } from '../tools/types.js';
import {
  SkillCatalog,
  createSkillTool,
  discoverSkills,
  narrowToolSpecs,
} from '../skills/index.js';
import {
  createTaskTool,
  discoverAgents,
  runSubagent,
  subagentToolSpecs,
} from '../subagents/index.js';
import type { AgentDefinition } from '../subagents/index.js';
import { McpHub, loadMcpConfig, resolveResources } from '../mcp/index.js';
import type { McpServerStatus } from '../mcp/index.js';
import { AGENT_CONVENTIONS, buildAgentSystemPrompt, buildSubagentSystemPrompt } from './prompt.js';
import { AgentLoop } from './loop.js';
import type { AgentEvent, AgentLoopOptions, AgentRunResult } from './loop.js';
import { mergeHooks } from './hooks.js';
import type { AgentHooks } from './hooks.js';
import { createToolGuardrailHooks } from './guardrails.js';
import type { ActiveSkill, AgentControl } from './control.js';
import {
  SessionRecorder,
  SessionState,
  loadSession,
  rebuildSessionState,
} from './session.js';
import { TraceRecorder } from '../telemetry/trace.js';
import { addUsage } from '../provider/types.js';
import type { Message, Usage } from '../provider/types.js';
import { ProviderRegistry } from '../provider/router.js';
import type { ResolvedModel } from '../provider/router.js';
import type { ContextBreakdown } from '../context/budget.js';

// ---------------------------------------------------------------------------
// Notices: the cold, structured status channel
// ---------------------------------------------------------------------------

export type NoticeLevel = 'info' | 'warn' | 'error';

export type NoticeKind =
  | 'session-start'
  | 'project-memory'
  | 'skills-discovered'
  | 'agents-discovered'
  | 'mcp-status'
  | 'permission-mode'
  | 'mode-changed'
  | 'skill-loaded'
  | 'sandbox-warn'
  | 'compaction'
  | 'context-warn'
  | 'provider-retry'
  | 'resource'
  | 'subagent'
  | 'error';

export interface Notice {
  kind: NoticeKind;
  level: NoticeLevel;
  text: string;
  data?: unknown;
}

/** A context-window snapshot, exposed after each turn and to the TUI meter. */
export interface ContextSnapshot {
  usedTokens: number;
  windowTokens: number;
  ratio: number;
  breakdown?: ContextBreakdown;
}

/** A `/name` slash command backed by an MCP prompt. */
export interface SlashCommandInfo {
  /** The bare command name, without the leading slash. */
  command: string;
  server: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentSessionConfig {
  cwd: string;
  model: ResolvedModel;
  /** Cheaper model for compaction summaries. Defaults to `settings.smallModel`, then `model`. */
  summarizerModel?: ResolvedModel;
  settings: Settings;
  budgets: ResolvedBudgets;

  mode?: PermissionMode;
  /** Mode to switch to after a plan is approved. Defaults to `settings` then `acceptEdits`. */
  planApprovedMode?: PermissionMode;
  allow?: string[];
  ask?: string[];
  deny?: string[];

  // Subsystem switches (all default true).
  skills?: boolean;
  subagents?: boolean;
  mcp?: boolean;
  compact?: boolean;
  recorder?: boolean;
  trace?: boolean;

  /** Continue a previous session (id, messages, read ledger). */
  resumeId?: string;
  /** Overrides `<projectRoot>/.agent` for recorder/trace output (eval harness). */
  agentDir?: string;
  /** Platform string for the system prompt. Defaults to `process.platform`. */
  platform?: string;
  /** Pre-loaded project memory; `null` skips loading, `undefined` loads it. */
  projectMemory?: { text: string; sources: string[] } | null;
  /** Escape hatch for ablations / tests; merged last into each `AgentLoop`. */
  loopOverrides?: Partial<AgentLoopOptions>;

  // Injected seams ----------------------------------------------------------
  /** Permission `ask` handler. Defaults to `nonInteractiveAskHandler` (deny). */
  askHandler?: AskHandler;
  /** Plan approval. Absent = `exit_plan_mode` writes the plan and ends the run. */
  confirm?: (req: { title: string; body: string }) => Promise<{ approved: boolean; feedback?: string }>;
  /** Hot path: per-token deltas and tool events, forwarded verbatim. */
  onEvent?: (e: AgentEvent) => void;
  /** Cold path: structured status lines. */
  onNotice?: (n: Notice) => void;
}

interface SessionInit {
  memory: ProjectMemory;
  agents: AgentDefinition[];
  hub: McpHub;
  mcpToolSpecs: AnyToolSpec[];
  mcpPrompts: Map<string, { server: string; name: string }>;
  skillCatalog: SkillCatalog;
  engine: PermissionEngine;
  planApprovedMode: PermissionMode;
  recorder: SessionRecorder | undefined;
  trace: TraceRecorder | undefined;
  session: SessionState;
  messages: Message[];
  hooks: AgentHooks;
  compactHook: AgentHooks | undefined;
  registry: ProviderRegistry;
  budgetOverrides: Partial<AgentLoopOptions>;
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export class AgentSession {
  readonly id: string;

  readonly #config: AgentSessionConfig;
  readonly #cwd: string;
  readonly #platform: string;
  readonly #model: ResolvedModel;
  readonly #registry: ProviderRegistry;
  readonly #engine: PermissionEngine;
  readonly #planApprovedMode: PermissionMode;
  readonly #memory: ProjectMemory;
  readonly #agents: AgentDefinition[];
  readonly #hub: McpHub;
  readonly #mcpToolSpecs: AnyToolSpec[];
  readonly #mcpPrompts: Map<string, { server: string; name: string }>;
  readonly #skillCatalog: SkillCatalog;
  readonly #recorder: SessionRecorder | undefined;
  readonly #trace: TraceRecorder | undefined;
  readonly #hooks: AgentHooks;
  readonly #compactHook: AgentHooks | undefined;
  readonly #budgetOverrides: Partial<AgentLoopOptions>;
  readonly #control: AgentControl;

  #session: SessionState;
  #messages: Message[];
  #taskTool: AnyToolSpec | undefined;
  #activeSkills: ActiveSkill[] = [];
  #sessionUsage: Usage | undefined;
  #lastContext: ContextSnapshot | undefined;
  #contextWarned = false;
  #abortController: AbortController | undefined;
  #closed = false;

  private constructor(config: AgentSessionConfig, init: SessionInit) {
    this.id = init.recorder?.id ?? init.trace?.id ?? config.resumeId ?? randomUUID();
    this.#config = config;
    this.#cwd = config.cwd;
    this.#platform = config.platform ?? process.platform;
    this.#model = config.model;
    this.#registry = init.registry;
    this.#engine = init.engine;
    this.#planApprovedMode = init.planApprovedMode;
    this.#memory = init.memory;
    this.#agents = init.agents;
    this.#hub = init.hub;
    this.#mcpToolSpecs = init.mcpToolSpecs;
    this.#mcpPrompts = init.mcpPrompts;
    this.#skillCatalog = init.skillCatalog;
    this.#recorder = init.recorder;
    this.#trace = init.trace;
    this.#session = init.session;
    this.#messages = init.messages;
    this.#hooks = init.hooks;
    this.#compactHook = init.compactHook;
    this.#budgetOverrides = init.budgetOverrides;

    const notice = (n: Notice): void => this.#config.onNotice?.(n);
    const engine = this.#engine;
    const activeSkills = this.#activeSkills;
    this.#control = {
      get mode(): PermissionMode {
        return engine.getMode();
      },
      get activeSkills(): readonly ActiveSkill[] {
        return activeSkills;
      },
      activateSkill: (skill: ActiveSkill): void => {
        if (this.#activeSkills.some((s) => s.name === skill.name)) return;
        this.#activeSkills.push(skill);
        notice({
          kind: 'skill-loaded',
          level: 'info',
          text:
            `skill loaded: ${skill.name}` +
            (skill.allowedTools
              ? ` — tools now limited to: ${skill.allowedTools.join(' ')}`
              : ''),
        });
      },
      exitPlanMode: (): PermissionMode => {
        this.#engine.setMode(this.#planApprovedMode);
        notice({
          kind: 'mode-changed',
          level: 'info',
          text: `mode: plan → ${this.#planApprovedMode}`,
        });
        return this.#planApprovedMode;
      },
      ...(config.confirm ? { confirm: config.confirm } : {}),
    };

    if (init.agents.length > 0) {
      this.#taskTool = createTaskTool({
        agents: init.agents,
        run: (def, subPrompt, runCtx) => this.#runSubagent(def, subPrompt, runCtx),
      });
    }
  }

  // -- construction ---------------------------------------------------------

  static async create(config: AgentSessionConfig): Promise<AgentSession> {
    const cwd = config.cwd;
    const settings = config.settings;
    const platform = config.platform ?? process.platform;
    const notify = (n: Notice): void => config.onNotice?.(n);
    const registry = new ProviderRegistry({ settings });

    const memory =
      config.projectMemory !== undefined
        ? (config.projectMemory ?? { text: '', sources: [] })
        : await loadProjectMemory(cwd);
    if (memory.sources.length > 0) {
      const rel = memory.sources.map((s) => resolve(s).replace(`${cwd}/`, ''));
      notify({ kind: 'project-memory', level: 'info', text: `project memory: ${rel.join(', ')}` });
    }

    const { skills, counts } =
      config.skills === false
        ? { skills: [], counts: { project: 0, user: 0, builtin: 0 } }
        : await discoverSkills(cwd, {
            onSkip: (reason) =>
              notify({ kind: 'skills-discovered', level: 'info', text: `skipped ${reason}` }),
          });
    const skillCatalog = new SkillCatalog(skills);
    if (skillCatalog.size > 0) {
      notify({
        kind: 'skills-discovered',
        level: 'info',
        text:
          `skills: ${skillCatalog.size} discovered ` +
          `(project ${counts.project}, user ${counts.user}, builtin ${counts.builtin})` +
          (skillCatalog.dropped.length > 0
            ? ` — ${skillCatalog.dropped.length} not advertised (manifest budget)`
            : ''),
      });
    }

    const { agents } =
      config.subagents === false
        ? { agents: [] }
        : await discoverAgents(cwd, {
            onSkip: (reason) =>
              notify({ kind: 'agents-discovered', level: 'info', text: `skipped ${reason}` }),
          });
    if (agents.length > 0) {
      notify({
        kind: 'agents-discovered',
        level: 'info',
        text: `agents: ${agents.length} available (${agents.map((a) => a.name).join(', ')})`,
      });
    }

    const mcpEnabled = config.mcp !== false;
    const mcpConfig = mcpEnabled ? await loadMcpConfig(cwd) : { servers: [], sources: [] };
    const hub = new McpHub(mcpConfig.servers);
    const mcpToolSpecs = hub.empty ? [] : await hub.toolSpecs();
    if (!hub.empty) {
      const s = hub.status();
      const ok = s.filter((x) => x.state === 'ready');
      const failed = s.filter((x) => x.state === 'failed');
      notify({
        kind: 'mcp-status',
        level: 'info',
        text:
          `mcp: ${ok.length}/${s.length} server${s.length === 1 ? '' : 's'} ready, ` +
          `${mcpToolSpecs.length} tool${mcpToolSpecs.length === 1 ? '' : 's'}` +
          (failed.length > 0
            ? ` — unavailable: ${failed
                .map((x) => `${x.name} (${x.error ?? 'failed'})`)
                .join(', ')}`
            : ''),
      });
    }
    const mcpPrompts = new Map<string, { server: string; name: string }>();
    if (!hub.empty) {
      for (const { server, prompt } of await hub.prompts()) {
        mcpPrompts.set(`${server}:${prompt.name}`, { server, name: prompt.name });
        if (!mcpPrompts.has(prompt.name)) mcpPrompts.set(prompt.name, { server, name: prompt.name });
      }
    }

    const agentDir = config.agentDir ?? join(await findProjectRoot(cwd), AGENT_DIR);
    const recorder =
      config.recorder === false ? undefined : new SessionRecorder(agentDir, config.resumeId);
    const traceOn = config.trace !== false && settings.telemetry?.enabled !== false;
    const trace = traceOn ? new TraceRecorder(agentDir, recorder?.id ?? randomUUID()) : undefined;
    const priorMessages =
      config.resumeId !== undefined ? await loadSession(agentDir, config.resumeId) : [];
    const session =
      config.resumeId !== undefined
        ? await rebuildSessionState(agentDir, config.resumeId, cwd)
        : new SessionState();

    const permissions = settings.permissions ?? {};
    const mode = config.mode ?? permissions.mode ?? 'ask';
    const planApprovedMode = config.planApprovedMode ?? permissions.planApprovedMode ?? 'acceptEdits';
    const engine = createPermissionEngine({
      workspaceRoot: cwd,
      mode,
      allow: [...(permissions.allow ?? []), ...(config.allow ?? [])],
      ask: [...(permissions.ask ?? []), ...(config.ask ?? [])],
      deny: [...(permissions.deny ?? []), ...(config.deny ?? [])],
    });
    notify({ kind: 'permission-mode', level: 'info', text: `permission mode: ${mode}` });

    if (!isSandboxExecAvailable()) {
      notify({
        kind: 'sandbox-warn',
        level: 'warn',
        text:
          'bash sandbox: unavailable — commands run without OS-level workspace confinement ' +
          "(sandbox-exec is macOS-only); the permission engine's review is still in effect.",
      });
    }

    const summarizer =
      config.summarizerModel ??
      (settings.smallModel ? registry.resolve(settings.smallModel) : config.model);
    const compactHook =
      config.compact === false
        ? undefined
        : {
            onCompact: createCompactor({
              provider: summarizer.provider,
              model: summarizer.model,
              conventions: AGENT_CONVENTIONS,
              ...(config.budgets.compactKeepTurns !== undefined
                ? { keepTurns: config.budgets.compactKeepTurns }
                : {}),
              onSkip: (reason) =>
                notify({ kind: 'compaction', level: 'info', text: reason }),
            }),
          };
    const askHandler = config.askHandler ?? nonInteractiveAskHandler;
    const guardrailsEnabled = settings.toolGuardrails !== false;
    const guardrailHook = guardrailsEnabled
      ? createToolGuardrailHooks({
          isReadOnly: readOnlyLookup([
            ...builtinTools(),
            ...(skillCatalog.size > 0
              ? [{ name: 'skill', readOnly: true } as AnyToolSpec]
              : []),
            ...(agents.length > 0
              ? [{ name: 'task', readOnly: false } as AnyToolSpec]
              : []),
            ...mcpToolSpecs,
          ]),
        })
      : undefined;
    const hooks = mergeHooks(
      createPermissionHooks(engine, askHandler),
      guardrailHook,
      compactHook,
    );

    const budgetOverrides: Partial<AgentLoopOptions> = {
      ...(config.budgets.maxTurns !== undefined ? { maxTurns: config.budgets.maxTurns } : {}),
      ...(config.budgets.contextCompactRatio !== undefined
        ? { contextCompactRatio: config.budgets.contextCompactRatio }
        : {}),
      ...(config.budgets.maxCostUSD !== undefined
        ? { maxCostUSD: config.budgets.maxCostUSD }
        : {}),
      ...(config.budgets.maxTokens !== undefined ? { maxTokens: config.budgets.maxTokens } : {}),
      ...(config.budgets.maxOutputTokens !== undefined
        ? { maxOutputTokens: config.budgets.maxOutputTokens }
        : {}),
      ...(config.budgets.temperature !== undefined
        ? { temperature: config.budgets.temperature }
        : {}),
    };

    const sessionInstance = new AgentSession(config, {
      memory,
      agents,
      hub,
      mcpToolSpecs,
      mcpPrompts,
      skillCatalog,
      engine,
      planApprovedMode,
      recorder,
      trace,
      session,
      messages: priorMessages,
      hooks,
      compactHook,
      registry,
      budgetOverrides,
    });

    const modeLabel = `${config.model.ref} · mode ${mode}`;
    notify({
      kind: 'session-start',
      level: 'info',
      text: `session ${sessionInstance.id} · cwd ${cwd} · ${modeLabel}`,
    });
    return sessionInstance;
  }

  // -- accessors ------------------------------------------------------------

  get mode(): PermissionMode {
    return this.#engine.getMode();
  }

  get activeSkills(): readonly ActiveSkill[] {
    return this.#activeSkills;
  }

  get contextSnapshot(): ContextSnapshot | undefined {
    return this.#lastContext;
  }

  get sessionUsage(): Usage | undefined {
    return this.#sessionUsage;
  }

  get messages(): readonly Message[] {
    return this.#messages;
  }

  get engine(): PermissionEngine {
    return this.#engine;
  }

  get mcpStatus(): McpServerStatus[] {
    return this.#hub.status();
  }

  listSlashCommands(): SlashCommandInfo[] {
    return [...this.#mcpPrompts.entries()].map(([command, ref]) => ({
      command,
      server: ref.server,
      name: ref.name,
    }));
  }

  // -- control --------------------------------------------------------------

  /** Abort an in-flight turn. Never touches process signals. */
  abort(): void {
    this.#abortController?.abort();
  }

  setMode(mode: PermissionMode): void {
    const prev = this.#engine.getMode();
    if (prev === mode) return;
    this.#engine.setMode(mode);
    this.#config.onNotice?.({
      kind: 'mode-changed',
      level: 'info',
      text: `mode: ${prev} → ${mode}`,
    });
  }

  /** Run one turn with `input`, then stop. Returns the full accumulated history. */
  async runTurn(input: string, opts?: { signal?: AbortSignal }): Promise<AgentRunResult> {
    if (this.#closed) throw new Error('AgentSession is closed');

    let effectiveText = input;
    if (!this.#hub.empty) {
      const { context, notes } = await resolveResources(this.#hub, input);
      for (const n of notes) {
        this.#config.onNotice?.({ kind: 'resource', level: 'info', text: `@resource ${n}` });
      }
      if (context.length > 0) effectiveText = `${context.join('\n\n')}\n\n${input}`;
    }

    const userMessage: Message = {
      role: 'user',
      content: [{ type: 'text', text: effectiveText }],
    };
    await this.#recorder?.recordMessage(userMessage);

    const startedAt = Date.now();
    await this.#trace?.append({
      type: 'run_start',
      ts: startedAt,
      sessionId: this.id,
      model: this.#model.ref,
      cwd: this.#cwd,
      mode: this.#engine.getMode(),
      resumed: this.#config.resumeId !== undefined,
    });

    const controller = new AbortController();
    this.#abortController = controller;
    const onExternalAbort = (): void => controller.abort();
    if (opts?.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const result = await this.#buildLoop(controller.signal).run([
        ...this.#messages,
        userMessage,
      ]);

      await this.#trace?.append({
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

      this.#messages = result.messages;
      this.#sessionUsage = this.#sessionUsage
        ? addUsage(this.#sessionUsage, result.usage)
        : result.usage;
      return result;
    } finally {
      opts?.signal?.removeEventListener('abort', onExternalAbort);
      this.#abortController = undefined;
    }
  }

  /** Manually compact history now. Returns the token savings, or null when nothing compacted. */
  async compactNow(): Promise<{ tokensBefore: number; tokensAfter: number } | null> {
    const onCompact = this.#compactHook?.onCompact;
    if (!onCompact) return null;
    const before = estimateRequestTokens({ messages: this.#messages });
    const result = await onCompact(
      this.#messages,
      { usedTokens: before, windowTokens: before, ratio: 1 },
      { turn: 0, cwd: this.#cwd },
    );
    if (!result || result.messages.length === 0) return null;
    const after = estimateRequestTokens({ messages: result.messages });
    this.#messages = result.messages;
    if (result.usage) {
      this.#sessionUsage = this.#sessionUsage
        ? addUsage(this.#sessionUsage, result.usage)
        : result.usage;
    }
    await this.#recorder?.recordCompaction([...result.messages], {
      tokensBefore: before,
      tokensAfter: after,
      keptTurns: result.keptTurns ?? 0,
    });
    this.#config.onNotice?.({
      kind: 'compaction',
      level: 'info',
      text: `context compacted: ${fmtTokens(before)} → ${fmtTokens(after)} tokens (kept last ${
        result.keptTurns ?? 0
      } turns)`,
    });
    return { tokensBefore: before, tokensAfter: after };
  }

  /** Resolve a `/name` slash command to an MCP prompt body, or null if unknown. */
  async expandSlash(text: string): Promise<string | null> {
    if (!text.startsWith('/')) return null;
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const ref = cmd ? this.#mcpPrompts.get(cmd) : undefined;
    if (!ref) return null;
    const conn = this.#hub.connection(ref.server);
    const body = await conn?.getPrompt(ref.name, rest.length > 0 ? { input: rest.join(' ') } : {});
    return body ?? null;
  }

  /** Idempotent teardown: close MCP connections and drop in-flight state. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#hub.closeAll();
  }

  // -- internals ------------------------------------------------------------

  #buildLoop(signal: AbortSignal): AgentLoop {
    const activeMode = this.#engine.getMode();
    const specs: AnyToolSpec[] = [
      ...builtinTools(),
      ...(activeMode === 'plan' ? [exitPlanModeTool] : []),
      ...(this.#skillCatalog.size > 0 ? [createSkillTool(this.#skillCatalog)] : []),
      ...(this.#taskTool ? [this.#taskTool] : []),
      ...this.#mcpToolSpecs,
    ];
    const narrowed = narrowToolSpecs(specs, this.#activeSkills);
    return new AgentLoop({
      model: this.#model,
      tools: new ToolRegistry(narrowed),
      cwd: this.#cwd,
      system: buildAgentSystemPrompt({
        cwd: this.#cwd,
        platform: this.#platform,
        mode: activeMode,
        ...(this.#memory.text ? { projectMemory: this.#memory.text } : {}),
        ...(this.#skillCatalog.manifest()
          ? { skillsManifest: this.#skillCatalog.manifest() }
          : {}),
      }),
      recorder: this.#recorder,
      ...(this.#trace ? { trace: this.#trace } : {}),
      session: this.#session,
      hooks: this.#hooks,
      control: this.#control,
      signal,
      ...this.#budgetOverrides,
      onEvent: this.#onEvent,
      ...this.#config.loopOverrides,
    });
  }

  #onEvent = (event: AgentEvent): void => {
    if (event.type === 'context') {
      this.#lastContext = {
        usedTokens: event.usedTokens,
        windowTokens: event.windowTokens,
        ratio: event.ratio,
        breakdown: event.breakdown,
      };
      if (event.ratio >= 0.8 && !this.#contextWarned) {
        this.#contextWarned = true;
        this.#config.onNotice?.({
          kind: 'context-warn',
          level: 'warn',
          text:
            `context ${fmtTokens(event.usedTokens)}/${fmtTokens(event.windowTokens)} ` +
            `(${Math.round(event.ratio * 100)}%) [${fmtBreakdown(event.breakdown)}] — approaching the window limit. ` +
            `History is compacted automatically near ~92%${
              this.#config.compact === false ? ' (disabled by --no-compact)' : ''
            }.`,
        });
      }
    } else if (event.type === 'compaction') {
      this.#config.onNotice?.({
        kind: 'compaction',
        level: 'info',
        text:
          `context compacted: ${fmtTokens(event.tokensBefore)} → ${fmtTokens(event.tokensAfter)} tokens ` +
          `(kept last ${event.keptTurns} turn${event.keptTurns === 1 ? '' : 's'})`,
      });
    } else if (event.type === 'turn_retry') {
      this.#config.onNotice?.({
        kind: 'provider-retry',
        level: 'warn',
        text:
          `provider: model call failed — retrying (${event.attempt}/${event.maxAttempts}) ` +
          `in ${(event.delayMs / 1000).toFixed(1)}s: ${event.message}`,
      });
    }
    this.#config.onEvent?.(event);
  };

  async #runSubagent(
    def: AgentDefinition,
    subPrompt: string,
    runCtx: { signal?: AbortSignal },
  ): Promise<import('../subagents/types.js').SubagentResult> {
    const childModel = def.model ? this.#registry.resolve(def.model) : this.#model;
    const permissions = this.#config.settings.permissions ?? {};
    const childEngine = createPermissionEngine({
      workspaceRoot: this.#cwd,
      mode: this.#engine.getMode(),
      allow: [...(permissions.allow ?? []), ...(this.#config.allow ?? [])],
      ask: [...(permissions.ask ?? []), ...(this.#config.ask ?? [])],
      deny: [...(permissions.deny ?? []), ...(this.#config.deny ?? [])],
    });
    const childTools = subagentToolSpecs(builtinTools(), def);
    const notice = (text: string): void =>
      this.#config.onNotice?.({ kind: 'subagent', level: 'info', text });

    notice(`  ⤷ ${def.name}: dispatched`);
    const result = await runSubagent({
      model: childModel,
      tools: childTools,
      system: buildSubagentSystemPrompt({
        cwd: this.#cwd,
        platform: this.#platform,
        role: def.body,
        ...(this.#memory.text ? { projectMemory: this.#memory.text } : {}),
      }),
      hooks: mergeHooks(
        createPermissionHooks(childEngine, nonInteractiveAskHandler),
        this.#config.settings.toolGuardrails !== false
          ? createToolGuardrailHooks({ isReadOnly: readOnlyLookup(childTools) })
          : undefined,
        this.#compactHook,
      ),
      cwd: this.#cwd,
      prompt: subPrompt,
      maxTurns: this.#config.budgets.subagentMaxTurns ?? 20,
      ...(this.#config.budgets.maxOutputTokens !== undefined
        ? { maxOutputTokens: this.#config.budgets.maxOutputTokens }
        : {}),
      ...(this.#config.budgets.temperature !== undefined
        ? { temperature: this.#config.budgets.temperature }
        : {}),
      ...(this.#config.budgets.contextCompactRatio !== undefined
        ? { contextCompactRatio: this.#config.budgets.contextCompactRatio }
        : {}),
      ...(runCtx.signal ? { signal: runCtx.signal } : {}),
      onEvent: (ev) => {
        if (ev.type === 'tool_call_start') {
          notice(`  ⤷ ${def.name}: ${ev.name} ${JSON.stringify(ev.input)}`);
        }
      },
    });
    notice(
      `  ⤷ ${def.name}: done (${result.turns} turn${result.turns === 1 ? '' : 's'}, ` +
        `${fmtTokens(result.usage.inputTokens + result.usage.outputTokens)} tokens)`,
    );
    this.#sessionUsage = this.#sessionUsage
      ? addUsage(this.#sessionUsage, result.usage)
      : result.usage;
    await this.#trace?.append({
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
  }
}

/** Build an `isReadOnly(name)` lookup from the specs a session or sub-agent will run. */
function readOnlyLookup(specs: readonly { name: string; readOnly: boolean }[]): (name: string) => boolean {
  const map = new Map(specs.map((s) => [s.name, s.readOnly]));
  return (name) => map.get(name) ?? false;
}
