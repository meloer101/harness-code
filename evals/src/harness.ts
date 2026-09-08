/**
 * Headless agent run — the eval-suite counterpart to `hc agent`.
 *
 * `packages/cli/src/index.ts`'s `agent` action assembles a runnable `AgentLoop`
 * from a dozen core primitives, but that assembly is not exported and is welded
 * to the REPL, the MCP hub, the interactive prompter and SIGINT handling. This
 * is the ~one-screen distillation a benchmark run actually needs: a model
 * (replayed from a cassette, or live behind a recorder), the builtin tools, the
 * permission engine, optional compaction, and a telemetry trace to read the
 * numbers back off.
 *
 * Determinism note: the model is fingerprinted on the request, and the request
 * embeds the absolute workspace path (system prompt `environment` segment, and
 * any `grep` output that lands in history). We pin `platform` and hand the
 * replay/record provider a `redactPaths: [workDir]` so a cassette recorded under
 * one temp dir replays under another.
 */

import { execFileSync } from 'node:child_process';

import {
  AGENT_CONVENTIONS,
  AgentLoop,
  ProviderRegistry,
  RecordingProvider,
  ReplayProvider,
  SessionState,
  ToolRegistry,
  buildAgentSystemPrompt,
  builtinTools,
  createCompactor,
  createPermissionEngine,
  createPermissionHooks,
  createTaskTool,
  discoverAgents,
  mergeHooks,
  nonInteractiveAskHandler,
  parseModelRef,
  resolveCapabilities,
  runSubagent,
  subagentToolSpecs,
  buildSubagentSystemPrompt,
  summarizeTrace,
  readTrace,
  TraceRecorder,
  userText,
} from '@harness-code/core';
import type {
  AgentRunResult,
  ModelCapabilities,
  PermissionMode,
  Provider,
  ResolvedModel,
  Settings,
  TraceSummary,
} from '@harness-code/core';

export interface HarnessOptions {
  /** Realpath'd workspace the agent operates in (fixture already materialized). */
  workDir: string;
  prompt: string;
  /** `provider/model`. Capabilities (incl. pricing) are resolved from this even in replay. */
  modelRef: string;
  mode: PermissionMode;
  /** Directory the trace jsonl is written under (`<traceDir>/traces/<traceId>.jsonl`). */
  traceDir: string;
  traceId: string;

  /** Replay from this cassette, or — with `record` — record into it. */
  cassettePath: string;
  /** Live-record mode: hit the real endpoint behind a `RecordingProvider`. */
  record?: boolean;
  /** Hit the real endpoint directly, writing nothing (for one-off ablation measurements). */
  live?: boolean;
  /** Settings for the live provider (keys, base urls). Used when `record` or `live`. */
  settings?: Settings;

  // Ablation knobs -----------------------------------------------------------
  /** Off disables compaction entirely; a number forces the trigger ratio. */
  compaction?: boolean | number;
  /** Shrink the model's context window (to exercise compaction on small tasks). */
  contextWindow?: number;
  /** Per-request output cap (also the window reservation). */
  maxOutputTokens?: number;
  /** Offer the `task` tool (builtin sub-agents). */
  subagents?: boolean;
  /** Force prompt-encoded tool calling instead of native `tools`. */
  promptTools?: boolean;

  maxTurns?: number;
  allow?: string[];
  deny?: string[];
}

export interface HarnessRun {
  result: AgentRunResult;
  trace: TraceSummary;
}

const DEFAULT_MAX_TURNS = 30;

/**
 * Normalization applied to a request before it is fingerprinted for the
 * cassette, on top of the workspace-path redaction. Tool output the agent runs
 * (`node --test` / `npm test`) carries per-run `duration_ms` timings that would
 * otherwise change the key on every replay.
 */
export function evalKeyScrub(s: string): string {
  return s.replace(/duration_ms['":\s]*[\d.]+/g, 'duration_ms 0');
}

export async function runAgentTask(opts: HarnessOptions): Promise<HarnessRun> {
  const { provider: providerId, model } = parseModelRef(opts.modelRef);
  const capabilities: ModelCapabilities = {
    ...resolveCapabilities(providerId, model, {}),
    ...(opts.promptTools ? { nativeTools: false } : {}),
    ...(opts.contextWindow ? { contextWindow: opts.contextWindow } : {}),
  };

  let provider: Provider;
  if (opts.record || opts.live) {
    const live = new ProviderRegistry({ settings: opts.settings ?? {} }).resolve(opts.modelRef);
    provider = opts.live
      ? live.provider
      : new RecordingProvider(live.provider, opts.cassettePath, {
          redactPaths: [opts.workDir],
          keyScrub: evalKeyScrub,
        });
  } else {
    provider = await ReplayProvider.load(opts.cassettePath, {
      redactPaths: [opts.workDir],
      keyScrub: evalKeyScrub,
    });
  }

  const resolved: ResolvedModel = {
    provider,
    providerId,
    model,
    ref: opts.modelRef,
    capabilities,
  };

  const engine = createPermissionEngine({
    workspaceRoot: opts.workDir,
    mode: opts.mode,
    allow: opts.allow ?? [],
    ask: [],
    deny: opts.deny ?? [],
  });

  const compactionOff = opts.compaction === false;
  const compactHook = compactionOff
    ? undefined
    : {
        onCompact: createCompactor({
          provider: resolved.provider,
          model: resolved.model,
          conventions: AGENT_CONVENTIONS,
        }),
      };
  const hooks = mergeHooks(createPermissionHooks(engine, nonInteractiveAskHandler), compactHook);

  const tools = [...builtinTools()];
  if (opts.subagents) {
    const { agents } = await discoverAgents(opts.workDir);
    if (agents.length > 0) {
      tools.push(
        createTaskTool({
          agents,
          async run(def, subPrompt, runCtx) {
            return runSubagent({
              model: resolved,
              tools: subagentToolSpecs(builtinTools(), def),
              system: buildSubagentSystemPrompt({ cwd: opts.workDir, role: def.body }),
              hooks: mergeHooks(
                createPermissionHooks(
                  createPermissionEngine({
                    workspaceRoot: opts.workDir,
                    mode: engine.getMode(),
                    allow: opts.allow ?? [],
                    ask: [],
                    deny: opts.deny ?? [],
                  }),
                  nonInteractiveAskHandler,
                ),
                compactHook,
              ),
              cwd: opts.workDir,
              prompt: subPrompt,
              ...(runCtx.signal ? { signal: runCtx.signal } : {}),
            });
          },
        }),
      );
    }
  }

  const trace = new TraceRecorder(opts.traceDir, opts.traceId);
  const startedAt = Date.now();
  await trace.append({
    type: 'run_start',
    ts: startedAt,
    sessionId: opts.traceId,
    model: opts.modelRef,
    cwd: opts.workDir,
    mode: opts.mode,
  });

  const loop = new AgentLoop({
    model: resolved,
    tools: new ToolRegistry(tools),
    cwd: opts.workDir,
    system: buildAgentSystemPrompt({ cwd: opts.workDir, mode: opts.mode, platform: 'linux' }),
    session: new SessionState(),
    hooks,
    trace,
    maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
    ...(typeof opts.compaction === 'number' ? { contextCompactRatio: opts.compaction } : {}),
    ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
  });

  const result = await loop.run([userText(opts.prompt)]);

  await trace.append({
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

  const events = await readTrace(opts.traceDir, opts.traceId);
  return { result, trace: summarizeTrace(opts.traceId, events) };
}

/**
 * Run a task's `assert.mjs` in the (post-run) workspace. Exit 0 = pass. Any
 * non-zero exit or a spawn failure = fail, with stdout+stderr captured.
 */
export function runAssertion(assertPath: string, workDir: string): { passed: boolean; output: string } {
  try {
    const output = execFileSync('node', [assertPath], {
      cwd: workDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { passed: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      passed: false,
      output: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim(),
    };
  }
}

