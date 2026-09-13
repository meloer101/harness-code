/**
 * The agent state machine: assemble request -> stream -> collect tool_use ->
 * permission gate -> parallel execute -> refill tool_result -> loop.
 *
 * Policy (what is allowed, how much context to keep, when to compact) is
 * deliberately kept out of this file — it lives behind `AgentHooks` so this
 * loop does not have to change shape as Phase 3/4/6/7 land.
 */

import { estimateCostUSD } from '../provider/capabilities.js';
import { backoffMs, sleep } from '../provider/retry.js';
import { analyzeStableParts, breakdownFrom } from '../context/budget.js';
import { estimateMessageTokens, estimateRequestTokens, heuristicTokenCount, createTokenCalibrator } from '../context/tokenizer.js';
import type { ResolvedModel } from '../provider/router.js';
import {
  ProviderError,
  addUsage,
  emptyUsage,
  toolUsesOf,
} from '../provider/types.js';
import type {
  Message,
  ModelRequest,
  ModelResponse,
  StopReason,
  SystemSegment,
  ToolChoice,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
} from '../provider/types.js';
import { allowedToolNames } from '../skills/narrow.js';
import { parseGoalAndPriorDigest } from '../context/compactor.js';
import { maybeVaryObservation } from './observations.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolResult } from '../tools/types.js';
import { errorMessage } from '../tools/util.js';
import type { ContextBreakdown } from '../context/budget.js';
import { allowAllHooks } from './hooks.js';
import type { AgentHooks, CompactionResult, PermissionDecision, TurnContext } from './hooks.js';
import type { AgentControl } from './control.js';
import { SessionState } from './session.js';
import type { SessionRecorder } from './session.js';

export type AgentStopReason =
  | 'end_turn'
  | 'max_turns'
  | 'max_cost'
  | 'max_tokens'
  | 'content_filter'
  | 'context_limit'
  | 'stopped_by_tool'
  | 'aborted'
  | 'error';

/** Map a non-tool_use provider stop into an agent stop. Budget `max_tokens` reuses the same name. */
function agentStopFrom(reason: StopReason): AgentStopReason {
  if (reason === 'max_tokens') return 'max_tokens';
  if (reason === 'content_filter') return 'content_filter';
  return 'end_turn';
}

const TRUNCATED_TOOL_HINT =
  'Previous model output hit the output-token limit mid tool-call arguments and could not be parsed. ' +
  'Split this write into smaller pieces and retry.';

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call_start'; id: string; name: string; input: unknown }
  | { type: 'tool_call_end'; id: string; name: string; result: ToolResult }
  | { type: 'turn_end'; usage: Usage }
  /**
   * The model call failed mid-stream with a retryable error and will be re-sent
   * after `delayMs`. Any `text_delta` / `thinking_delta` already emitted for
   * this turn is void — consumers must discard it. `attempt` is 1-based.
   */
  | { type: 'turn_retry'; attempt: number; maxAttempts: number; delayMs: number; message: string }
  | {
      type: 'context';
      usedTokens: number;
      windowTokens: number;
      ratio: number;
      breakdown: ContextBreakdown;
    }
  | { type: 'compaction'; tokensBefore: number; tokensAfter: number; keptTurns: number }
  | { type: 'stop'; reason: AgentStopReason };

/**
 * Where per-turn telemetry goes. The loop hands over rich objects at the same
 * points it feeds `recorder`; shaping them into on-disk trace events (capping
 * input summaries, byte counts) is the sink's job. Every method is awaited, so a
 * crash loses at most the in-flight turn — same contract as `SessionRecorder`.
 * `TraceRecorder` in `telemetry/trace.ts` is the implementation.
 */
export interface TraceSink {
  modelCall(r: {
    turn: number;
    model: string;
    usage: Usage;
    costUSD?: number;
    latencyMs?: number;
    ttftMs?: number;
    stopReason: string;
  }): Promise<void>;
  toolCall(r: {
    turn: number;
    id: string;
    name: string;
    input: unknown;
    durationMs: number;
    result: ToolResult;
    /** The permission engine refused this call — it never ran. */
    denied: boolean;
  }): Promise<void>;
  compaction(r: {
    turn: number;
    tokensBefore: number;
    tokensAfter: number;
    keptTurns: number;
    costUSD?: number;
  }): Promise<void>;
  context(r: {
    turn: number;
    usedTokens: number;
    windowTokens: number;
    ratio: number;
    breakdown: ContextBreakdown;
  }): Promise<void>;
  error(r: {
    turn: number;
    scope: 'provider' | 'tool';
    message: string;
    /** The turn will be re-sent (a retryable provider failure within budget). */
    willRetry?: boolean;
  }): Promise<void>;
}

export interface AgentRunResult {
  messages: Message[];
  usage: Usage;
  stopReason: AgentStopReason;
  /** Model calls that completed before the loop stopped. */
  turns: number;
}

export interface AgentLoopOptions {
  model: ResolvedModel;
  tools: ToolRegistry;
  cwd: string;
  system?: SystemSegment[];
  session?: SessionState;
  recorder?: SessionRecorder;
  /** Per-turn telemetry. Absent = no trace written. */
  trace?: TraceSink;
  hooks?: AgentHooks;
  maxTurns?: number;
  /**
   * Past ~60% of `maxTurns`, append a short ephemeral note to the turn's
   * message telling the model how many turns remain and to converge on a
   * solution rather than keep exploring. The note is never persisted to
   * history — it is rebuilt each turn and only present in that turn's request.
   * Default `true`; set `false` to measure the un-nudged behaviour.
   */
  turnBudgetHints?: boolean;
  /**
   * After a run of turns whose tool calls all failed, append an ephemeral
   * "step back and reconsider" note (same delivery as `turnBudgetHints`). Cuts
   * the "retry the same failing command with a tweaked flag" loop. Default
   * `true`.
   */
  stepBackHints?: boolean;
  /**
   * Past turn 12, every 8 turns, append an ephemeral restatement of the
   * original goal and any open todos. Counters lost-in-the-middle in long
   * sessions that have not yet compacted. Default `true`.
   */
  goalRestateHints?: boolean;
  /**
   * Rotate the wrapper around newly-created successful tool_result bodies so
   * long sessions do not overfit a single observation template. Default
   * `false` — off until a repeated-pattern regression is observed.
   */
  varyObservations?: boolean;
  maxCostUSD?: number;
  /** Stop once cumulative input+output tokens exceed this. */
  maxTokens?: number;
  /** Per-request output cap; also reserved out of the context window. Defaults to the model's ceiling. */
  maxOutputTokens?: number;
  temperature?: number;
  /** Fraction of the usable context window at which `onContextPressure` fires. */
  contextWarnRatio?: number;
  /**
   * Fraction of the usable context window at which `onCompact` is invoked —
   * above the warn ratio, and tried before the hard stop. Pass `Infinity` (what
   * `--no-compact` does) to disable compaction entirely.
   */
  contextCompactRatio?: number;
  /** Fraction of the usable context window at which the loop stops with `context_limit`. */
  contextStopRatio?: number;
  /** Cap on concurrently running read-only tool calls within one turn. */
  concurrency?: number;
  /**
   * How many times a model call that fails with a *retryable* `ProviderError`
   * (a stream dropped or timed out mid-flight, a 5xx/429 that outlasted the
   * transport's own retries) is re-sent before the error propagates. The
   * failure happens before any tool runs, so re-sending the same request is
   * side-effect free. Default 2; `0` restores fail-fast.
   */
  maxTurnRetries?: number;
  /** Delay before turn retry `attempt` (0-based). Defaults to exponential backoff; tests inject 0. */
  retryBackoffMs?: (attempt: number) => number;
  /**
   * Cap on how many times `onBeforeStop` may push a continuation and keep the
   * run going. Default 2. Only relevant when a hook implements `onBeforeStop`.
   */
  maxStopGateContinuations?: number;
  /**
   * On the final turn (`turn >= maxTurns`), omit tools and ask for a text
   * summary instead of letting the model burn the last turn on another tool
   * call. Intended for sub-agents; main agent default is off.
   */
  finalSummaryTurn?: boolean;
  signal?: AbortSignal;
  /** Passed through to every tool's `ctx.control`. */
  control?: AgentControl;
  onEvent?(event: AgentEvent): void;
}

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_TURN_RETRIES = 2;
const DEFAULT_MAX_STOP_GATE_CONTINUATIONS = 2;
const DEFAULT_CONTEXT_WARN_RATIO = 0.8;
const DEFAULT_CONTEXT_COMPACT_RATIO = 0.92;
const DEFAULT_CONTEXT_STOP_RATIO = 0.95;
/**
 * Headroom kept free for this turn's output when sizing the usable window.
 * Separate from `maxOutputTokens` (the per-request cap): a model may allow a
 * 384k response, but reserving that much would waste most of a 1M window on
 * output we almost never generate. A turn that legitimately needs a longer
 * reply still gets it — this only bounds the *reservation*.
 */
const OUTPUT_RESERVE_CEILING = 64_000;

interface Decision {
  call: ToolUseBlock;
  decision: PermissionDecision;
}

export class AgentLoop {
  private readonly hooks: AgentHooks;
  private readonly session: SessionState;
  private readonly maxTurns: number;
  private readonly concurrency: number;
  private readonly maxOutputTokens: number;
  private readonly contextWarnRatio: number;
  private readonly contextCompactRatio: number;
  private readonly contextStopRatio: number;
  private readonly turnBudgetHints: boolean;
  private readonly stepBackHints: boolean;
  private readonly goalRestateHints: boolean;
  private readonly varyObservations: boolean;
  private readonly maxTurnRetries: number;
  private readonly maxStopGateContinuations: number;
  private readonly finalSummaryTurn: boolean;
  private readonly retryBackoffMs: (attempt: number) => number;
  private readonly calibrator = createTokenCalibrator();

  constructor(private readonly opts: AgentLoopOptions) {
    this.hooks = opts.hooks ?? allowAllHooks;
    this.session = opts.session ?? new SessionState();
    this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.turnBudgetHints = opts.turnBudgetHints ?? true;
    this.stepBackHints = opts.stepBackHints ?? true;
    this.goalRestateHints = opts.goalRestateHints ?? true;
    this.varyObservations = opts.varyObservations ?? false;
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    this.maxTurnRetries = Math.max(0, opts.maxTurnRetries ?? DEFAULT_MAX_TURN_RETRIES);
    this.maxStopGateContinuations = Math.max(
      0,
      opts.maxStopGateContinuations ?? DEFAULT_MAX_STOP_GATE_CONTINUATIONS,
    );
    this.finalSummaryTurn = opts.finalSummaryTurn ?? false;
    this.retryBackoffMs = opts.retryBackoffMs ?? backoffMs;
    this.maxOutputTokens = opts.maxOutputTokens ?? opts.model.capabilities.maxOutputTokens;
    this.contextWarnRatio = opts.contextWarnRatio ?? DEFAULT_CONTEXT_WARN_RATIO;
    this.contextCompactRatio = opts.contextCompactRatio ?? DEFAULT_CONTEXT_COMPACT_RATIO;
    this.contextStopRatio = opts.contextStopRatio ?? DEFAULT_CONTEXT_STOP_RATIO;
  }

  async run(initialMessages: Message[]): Promise<AgentRunResult> {
    const messages: Message[] = [...initialMessages];
    let usage = emptyUsage();
    let costUSD = 0;
    let turn = 0;
    let completedTurns = 0;

    // Usable window: the whole context minus the headroom we reserve for this
    // turn's output. `contextWindow` is always populated (DEFAULT_CAPABILITIES).
    // The reservation is capped at OUTPUT_RESERVE_CEILING so a model with a huge
    // `maxOutputTokens` (e.g. DeepSeek V4's 384k) does not shrink the window by
    // output it will almost never produce.
    const outputReserve = Math.min(this.maxOutputTokens, OUTPUT_RESERVE_CEILING);
    const availableWindow = Math.max(
      1,
      this.opts.model.capabilities.contextWindow - outputReserve,
    );
    // The fixed buckets — system / project memory / tool schemas — don't change
    // within a run, so cost them once. `history` is then the remainder of the
    // anchored total, no full re-flatten per turn.
    const stableParts = analyzeStableParts(
      {
        system: this.opts.system,
        tools: this.opts.tools.definitions(),
      },
      this.calibrator.count,
    );
    // Anchored on the endpoint's real `usage` from the previous turn, so
    // estimation error only accrues on the tool_result messages we appended
    // since — not on a full-history heuristic pass every turn.
    let prevUsage: Usage | undefined;
    let appendedTokens = 0;
    // Consecutive turns whose every tool call errored — drives the step-back note.
    let consecutiveFailedTurns = 0;
    // How many times onBeforeStop has already continued this run.
    let stopGateContinuations = 0;

    for (;;) {
      turn++;
      if (this.opts.signal?.aborted) return this.stop(messages, usage, completedTurns, 'aborted');
      if (turn > this.maxTurns) return this.stop(messages, usage, completedTurns, 'max_turns');
      if (this.opts.maxCostUSD !== undefined && costUSD > this.opts.maxCostUSD) {
        return this.stop(messages, usage, completedTurns, 'max_cost');
      }

      const turnCtx: TurnContext = {
        turn,
        cwd: this.opts.cwd,
        ...(this.opts.signal ? { signal: this.opts.signal } : {}),
      };
      await this.hooks.onBeforeTurn?.(turnCtx);

      const toolless =
        this.finalSummaryTurn && Number.isFinite(this.maxTurns) && turn >= this.maxTurns;

      const request: ModelRequest = {
        model: this.opts.model.model,
        messages,
        ...(toolless ? {} : { tools: this.opts.tools.definitions() }),
        maxOutputTokens: this.maxOutputTokens,
        ...(this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : {}),
        ...(this.opts.system ? { system: this.opts.system } : {}),
        ...(this.opts.signal ? { signal: this.opts.signal } : {}),
      };
      if (!toolless) {
        const toolChoice = this.skillToolChoice();
        if (toolChoice) request.toolChoice = toolChoice;
      }
      request.messages = this.withEphemeralNotes(
        messages,
        turn,
        consecutiveFailedTurns,
        toolless,
      );

      if (
        this.opts.maxTokens !== undefined &&
        usage.inputTokens + usage.outputTokens > this.opts.maxTokens
      ) {
        return this.stop(messages, usage, completedTurns, 'max_tokens');
      }

      let contextTokens =
        prevUsage === undefined
          ? estimateRequestTokens(request, this.calibrator.count)
          : prevUsage.inputTokens + prevUsage.outputTokens + appendedTokens;
      let ratio = contextTokens / availableWindow;

      // Compaction gets first refusal at a nearly-full window: if it swaps in a
      // shorter history the stop below is re-evaluated against it, so a session
      // continues instead of ending. A skipped or failed compaction falls
      // through to `context_limit` unchanged.
      if (ratio >= this.contextCompactRatio && this.hooks.onCompact) {
        const compacted = await this.hooks.onCompact(
          messages,
          { usedTokens: contextTokens, windowTokens: availableWindow, ratio },
          turnCtx,
        );
        if (compacted && compacted.messages.length > 0) {
          const applied = await this.applyCompaction(
            messages,
            compacted,
            turn,
            request,
            usage,
            costUSD,
            contextTokens,
          );
          usage = applied.usage;
          costUSD = applied.costUSD;
          prevUsage = undefined;
          appendedTokens = 0;
          contextTokens = applied.contextTokens;
          ratio = contextTokens / availableWindow;
          request.messages = this.withEphemeralNotes(
            messages,
            turn,
            consecutiveFailedTurns,
            toolless,
          );
        }
      }

      const breakdown = breakdownFrom(stableParts, contextTokens);
      this.emit({
        type: 'context',
        usedTokens: contextTokens,
        windowTokens: availableWindow,
        ratio,
        breakdown,
      });
      await this.opts.trace?.context({
        turn,
        usedTokens: contextTokens,
        windowTokens: availableWindow,
        ratio,
        breakdown,
      });

      if (ratio >= this.contextStopRatio) {
        return this.stop(messages, usage, completedTurns, 'context_limit');
      }
      if (ratio >= this.contextWarnRatio) {
        await this.hooks.onContextPressure?.(turnCtx, {
          usedTokens: contextTokens,
          windowTokens: availableWindow,
          ratio,
        });
      }

      // At most one mid-turn salvage: provider says context_length → compact once
      // and re-send. Without onCompact (--no-compact) or after a failed salvage,
      // fall through to the existing error path.
      let response: ModelResponse;
      let salvagedContext = false;
      for (;;) {
        try {
          response = await this.streamTurnWithRetry(request, turn);
          break;
        } catch (err) {
          const canSalvage =
            err instanceof ProviderError &&
            err.kind === 'context_length' &&
            this.hooks.onCompact !== undefined &&
            !salvagedContext;
          if (canSalvage) {
            salvagedContext = true;
            const compacted = await this.hooks.onCompact!(
              messages,
              {
                usedTokens: contextTokens,
                windowTokens: availableWindow,
                ratio: contextTokens / availableWindow,
              },
              turnCtx,
            );
            if (compacted && compacted.messages.length > 0) {
              const applied = await this.applyCompaction(
                messages,
                compacted,
                turn,
                request,
                usage,
                costUSD,
                contextTokens,
              );
              usage = applied.usage;
              costUSD = applied.costUSD;
              prevUsage = undefined;
              appendedTokens = 0;
              contextTokens = applied.contextTokens;
              request.messages = this.withEphemeralNotes(
                messages,
                turn,
                consecutiveFailedTurns,
                toolless,
              );
              continue;
            }
          }
          if (err instanceof ProviderError && err.kind === 'aborted') {
            return this.stop(messages, usage, completedTurns, 'aborted');
          }
          await this.opts.trace?.error({
            turn,
            scope: 'provider',
            message: err instanceof Error ? err.message : String(err),
          });
          // A ProviderError is a known, reportable failure — let it propagate so
          // the caller can surface it. Anything else escaping the provider (an
          // unclassified stream/transport error) must not take the process down:
          // end the run at `error` so `runTurn` returns a result the caller can
          // inspect, same as any other stop reason.
          if (err instanceof ProviderError) throw err;
          return this.stop(messages, usage, completedTurns, 'error');
        }
      }

      usage = addUsage(usage, response.usage);
      if (!response.usage.estimated && response.usage.inputTokens > 0) {
        this.calibrator.observe(
          estimateRequestTokens(request, heuristicTokenCount),
          response.usage.inputTokens,
        );
      }
      const pricing = this.opts.model.capabilities.pricing;
      const callCostUSD = pricing ? estimateCostUSD(response.usage, pricing) : undefined;
      if (callCostUSD !== undefined) costUSD += callCostUSD;
      this.emit({ type: 'turn_end', usage: response.usage });
      completedTurns++;
      await this.opts.trace?.modelCall({
        turn,
        model: this.opts.model.ref,
        usage: response.usage,
        ...(callCostUSD !== undefined ? { costUSD: callCostUSD } : {}),
        ...(response.latencyMs !== undefined ? { latencyMs: response.latencyMs } : {}),
        ...(response.ttftMs !== undefined ? { ttftMs: response.ttftMs } : {}),
        stopReason: response.stopReason,
      });

      const assistantMessage: Message = { role: 'assistant', content: response.content };
      messages.push(assistantMessage);
      await this.opts.recorder?.recordMessage(assistantMessage);

      const calls = toolUsesOf(response.content);
      // Truncation mid tool-call args: keep going so we return an error tool_result
      // (tier 3) instead of dropping the call. Pure text truncation / content_filter
      // stop with a distinct reason (tier 1) — never disguise as end_turn.
      if (response.stopReason !== 'tool_use') {
        const truncatedTools =
          response.stopReason === 'max_tokens' && calls.length > 0;
        if (!truncatedTools) {
          const reason = agentStopFrom(response.stopReason);
          if (
            reason === 'end_turn' &&
            this.hooks.onBeforeStop &&
            stopGateContinuations < this.maxStopGateContinuations
          ) {
            const decision = await this.hooks.onBeforeStop(assistantMessage, turnCtx);
            if (decision?.continue) {
              stopGateContinuations++;
              const contMsg: Message = {
                role: 'user',
                content: [{ type: 'text', text: decision.continue }],
              };
              messages.push(contMsg);
              await this.opts.recorder?.recordMessage(contMsg);
              prevUsage = response.usage;
              appendedTokens = estimateMessageTokens([contMsg], this.calibrator.count);
              continue;
            }
          }
          return this.stop(messages, usage, completedTurns, reason);
        }
      }

      const { blocks, endsRun } = await this.runToolCalls(calls, turnCtx, {
        truncated: response.stopReason === 'max_tokens',
      });
      const userMessage: Message = { role: 'user', content: blocks };
      messages.push(userMessage);
      await this.opts.recorder?.recordMessage(userMessage);

      // A turn where every tool call errored is a stall; a run of them means the
      // model is retrying a dead end. Any success resets the counter.
      const allFailed = blocks.length > 0 && blocks.every((b) => b.isError === true);
      consecutiveFailedTurns = allFailed ? consecutiveFailedTurns + 1 : 0;

      if (endsRun) return this.stop(messages, usage, completedTurns, 'stopped_by_tool');

      prevUsage = response.usage;
      appendedTokens = estimateMessageTokens([userMessage], this.calibrator.count);
    }
  }

  private stop(
    messages: Message[],
    usage: Usage,
    turns: number,
    reason: AgentStopReason,
  ): AgentRunResult {
    this.emit({ type: 'stop', reason });
    return { messages, usage, stopReason: reason, turns };
  }

  /**
   * Ephemeral nudges (turn budget, step-back-when-stuck, final summary): rebuilt
   * each turn, appended only to this request's trailing message, never written
   * back to history. Keeps the cached prefix (system + prior turns) stable.
   */
  private withEphemeralNotes(
    messages: Message[],
    turn: number,
    consecutiveFailedTurns: number,
    toolless = false,
  ): Message[] {
    const notes = [
      this.goalRestateNote(messages, turn),
      toolless ? this.finalSummaryNote(turn) : this.turnBudgetNote(turn),
      this.stallNote(consecutiveFailedTurns),
    ].filter((n): n is string => n !== undefined);
    if (notes.length === 0 || messages.length === 0) return messages;
    const last = messages[messages.length - 1]!;
    return [
      ...messages.slice(0, -1),
      { ...last, content: [...last.content, { type: 'text', text: notes.join('\n\n') }] },
    ];
  }

  /** Last-turn prompt when tools are disabled — forces a text summary. */
  private finalSummaryNote(turn: number): string {
    return (
      `[turn budget] This is turn ${turn} of ${this.maxTurns} — the final turn. Tools are ` +
      `disabled for this turn; reply with text only. Summarize: (1) what you completed, ` +
      `(2) what remains unfinished, (3) the concrete next steps you recommend. Do not ` +
      `claim tools are still available.`
    );
  }

  /**
   * Apply an `onCompact` result: replace history, fold usage/cost, emit and
   * record. Shared by the ratio-triggered compact and the mid-turn salvage.
   */
  private async applyCompaction(
    messages: Message[],
    compacted: CompactionResult,
    turn: number,
    request: ModelRequest,
    usage: Usage,
    costUSD: number,
    tokensBefore: number,
  ): Promise<{ usage: Usage; costUSD: number; contextTokens: number }> {
    messages.length = 0;
    messages.push(...compacted.messages);
    let nextUsage = usage;
    let nextCost = costUSD;
    let compactionCostUSD: number | undefined;
    if (compacted.usage) {
      nextUsage = addUsage(usage, compacted.usage);
      const pricing = this.opts.model.capabilities.pricing;
      if (pricing) {
        compactionCostUSD = estimateCostUSD(compacted.usage, pricing);
        nextCost += compactionCostUSD ?? 0;
      }
    }
    const contextTokens = estimateRequestTokens({ ...request, messages }, this.calibrator.count);
    const keptTurns = compacted.keptTurns ?? 0;
    this.emit({
      type: 'compaction',
      tokensBefore,
      tokensAfter: contextTokens,
      keptTurns,
    });
    await this.opts.recorder?.recordCompaction([...messages], {
      tokensBefore,
      tokensAfter: contextTokens,
      keptTurns,
    });
    await this.opts.trace?.compaction({
      turn,
      tokensBefore,
      tokensAfter: contextTokens,
      keptTurns,
      ...(compactionCostUSD !== undefined ? { costUSD: compactionCostUSD } : {}),
    });
    return { usage: nextUsage, costUSD: nextCost, contextTokens };
  }

  /**
   * The turn-budget nudge for `turn`, or `undefined` before ~60% of the budget
   * is spent. Escalates: converge → commit-and-verify → last-turn.
   *
   * Rationale (from Terminal-Bench traces): with a large context window the
   * model rarely hits `context_limit`, so nothing pushes it to stop exploring —
   * runs write scratch script after scratch script and only touch the real
   * deliverable near the wall, then get cut off mid-thought at `max_turns`.
   * The commit-and-verify tier also says to fall back to the simplest working
   * implementation: without that, "commit to your solution" can dig a run
   * deeper into a wrong approach (observed: a task where it kept building a
   * C extension instead of falling back to the one-line library call).
   */
  private turnBudgetNote(turn: number): string | undefined {
    if (!this.turnBudgetHints) return undefined;
    const max = this.maxTurns;
    if (!Number.isFinite(max) || max < 5) return undefined;
    if (turn < Math.ceil(max * 0.6)) return undefined;

    const remaining = max - turn; // turns left *after* this one
    const head = `[turn budget] This is turn ${turn} of ${max}; ${remaining} will remain after it.`;
    if (remaining <= 0) {
      return (
        `${head} This is your final turn. Apply your best current solution directly to the ` +
        `real target file(s) now and stop — do not run more investigation or scratch scripts.`
      );
    }
    if (turn >= Math.ceil(max * 0.8)) {
      return (
        `${head} Stop exploring. Commit to your best solution, apply it to the real target ` +
        `file(s), verify it once, then finish. Don't start new investigations. If your ` +
        `current approach keeps failing, fall back to the simplest implementation that ` +
        `could pass rather than pushing the same approach further.`
      );
    }
    return (
      `${head} You are past the two-thirds mark — prefer converging on and implementing a ` +
      `solution over further investigation or benchmarking.`
    );
  }

  /**
   * The step-back note once several turns in a row have had every tool call
   * fail — the signature of retrying a dead end (same command, tweaked flag).
   */
  private stallNote(consecutiveFailedTurns: number): string | undefined {
    if (!this.stepBackHints) return undefined;
    if (consecutiveFailedTurns < 3) return undefined;
    return (
      `[step back] Your last ${consecutiveFailedTurns} turns' tool calls have all failed. ` +
      `Stop retrying variations of the same command or approach. Reconsider from the top: is ` +
      `this the right path, and what is the simplest thing that would satisfy the task? If you ` +
      `are genuinely blocked, say so and stop rather than burning more turns.`
    );
  }

  /**
   * Restate the original goal (and open todos) every 8 turns once the session
   * is long enough that the first user message has drifted into the middle.
   */
  private goalRestateNote(messages: Message[], turn: number): string | undefined {
    if (!this.goalRestateHints) return undefined;
    if (turn < 12 || turn % 8 !== 0) return undefined;
    const head = messages[0];
    if (!head) return undefined;
    const clipped = parseGoalAndPriorDigest(head).goal.trim().slice(0, 500);
    if (clipped === '') return undefined;
    const open = this.session.getTodos().filter((t) => t.status !== 'completed');
    const parts = [`[goal reminder] Original goal:\n${clipped}`];
    if (open.length > 0) {
      parts.push(`Open todos:\n${open.map((t) => `- [${t.status}] ${t.content}`).join('\n')}`);
    }
    return parts.join('\n\n');
  }

  private emit(event: AgentEvent): void {
    this.opts.onEvent?.(event);
  }

  /**
   * `streamTurn`, re-sent up to `maxTurnRetries` times when it fails with a
   * retryable `ProviderError`. The transport already retries the initial fetch;
   * this covers what it cannot — a stream that dies after bytes have flowed —
   * so one transient blip no longer ends the run. Emits `turn_retry` before
   * each wait so consumers can drop the aborted attempt's partial deltas. An
   * abort during the wait surfaces as `ProviderError('aborted')`, which the
   * caller turns into the `aborted` stop.
   */
  private async streamTurnWithRetry(request: ModelRequest, turn: number): Promise<ModelResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.streamTurn(request);
      } catch (err) {
        const retryable =
          err instanceof ProviderError && err.retryable && err.kind !== 'aborted';
        if (!retryable || attempt >= this.maxTurnRetries || this.opts.signal?.aborted) throw err;
        const delayMs =
          err.retryAfterMs !== undefined
            ? err.retryAfterMs
            : Math.round(this.retryBackoffMs(attempt));
        await this.opts.trace?.error({
          turn,
          scope: 'provider',
          message: err.message,
          willRetry: true,
        });
        this.emit({
          type: 'turn_retry',
          attempt: attempt + 1,
          maxAttempts: this.maxTurnRetries,
          delayMs,
          message: err.message,
        });
        await sleep(delayMs, this.opts.signal);
      }
    }
  }

  /** Consumes the stream, forwarding deltas out, and returns the final response. */
  private async streamTurn(request: ModelRequest): Promise<ModelResponse> {
    let last: ModelResponse | undefined;
    for await (const ev of this.opts.model.provider.stream(request)) {
      switch (ev.type) {
        case 'text_delta':
          this.emit({ type: 'text_delta', text: ev.text });
          break;
        case 'thinking_delta':
          this.emit({ type: 'thinking_delta', text: ev.text });
          break;
        case 'message_end':
          last = ev.response;
          break;
        default:
          break;
      }
    }
    if (!last) {
      throw new ProviderError('protocol', 'Stream ended without a message_end event');
    }
    return last;
  }

  private async runToolCalls(
    calls: ToolUseBlock[],
    turnCtx: TurnContext,
    opts: { truncated?: boolean } = {},
  ): Promise<{ blocks: ToolResultBlock[]; endsRun: boolean }> {
    const decisions: Decision[] = await Promise.all(
      calls.map(async (call) => ({
        call,
        decision: (await this.hooks.onBeforeToolCall?.(call, turnCtx)) ?? { decision: 'allow' },
      })),
    );

    const results = new Map<string, ToolResult>();

    const execute = async ({
      call,
      decision,
    }: Decision): Promise<{ result: ToolResult; durationMs: number }> => {
      const startedAt = Date.now();
      const result = await this.executeOne(call, decision, opts.truncated === true);
      const durationMs = Date.now() - startedAt;
      const feedback = await this.hooks.onAfterToolCall?.(call, result, turnCtx);
      if (feedback?.appendToResult) {
        result.content =
          result.content === ''
            ? feedback.appendToResult
            : `${result.content}\n\n${feedback.appendToResult}`;
      }
      return { result, durationMs };
    };

    const finish = async (
      { call, decision }: Decision,
      outcome: { result: ToolResult; durationMs: number },
    ): Promise<void> => {
      results.set(call.id, outcome.result);
      this.emit({ type: 'tool_call_end', id: call.id, name: call.name, result: outcome.result });
      await this.opts.recorder?.recordToolCall({
        id: call.id,
        name: call.name,
        input: call.input,
        result: outcome.result,
      });
      await this.opts.trace?.toolCall({
        turn: turnCtx.turn,
        id: call.id,
        name: call.name,
        input: call.input,
        durationMs: outcome.durationMs,
        result: outcome.result,
        denied: decision.decision === 'deny',
      });
    };

    const runOne = async (item: Decision): Promise<void> => {
      this.emit({
        type: 'tool_call_start',
        id: item.call.id,
        name: item.call.name,
        input: item.call.input,
      });
      await finish(item, await execute(item));
    };

    // A concurrency-safe batch executes its calls in parallel, but the
    // tool_call_end event (and the recorder/trace log it feeds) must still
    // land in the model's original emission order: a later call that happens
    // to finish first must not be reported "done" before an earlier, slower
    // one. `pending` holds outcomes that completed out of order; `drain`
    // flushes them once every earlier index in the batch has already been
    // flushed, so ordering holds without giving up parallel execution.
    const runBatchInOrder = async (batch: Decision[]): Promise<void> => {
      const pending = new Map<number, { result: ToolResult; durationMs: number }>();
      let nextFlush = 0;
      const drain = async (): Promise<void> => {
        while (pending.has(nextFlush)) {
          const outcome = pending.get(nextFlush)!;
          pending.delete(nextFlush);
          await finish(batch[nextFlush]!, outcome);
          nextFlush++;
        }
      };
      const runAt = async (idx: number): Promise<void> => {
        const item = batch[idx]!;
        this.emit({
          type: 'tool_call_start',
          id: item.call.id,
          name: item.call.name,
          input: item.call.input,
        });
        pending.set(idx, await execute(item));
        await drain();
      };
      await runWithConcurrency(
        batch.map((_, idx) => idx),
        this.concurrency,
        runAt,
      );
    };

    // Walk the model's order. Continuous concurrency-safe calls form a batch
    // and run together; a non-safe call is a barrier that runs alone after
    // any preceding batch drains. That keeps `[edit, read]` as edit-then-read
    // while still parallelising consecutive reads / tasks.
    const isParallelisable = ({ call, decision }: Decision): boolean => {
      if (decision.decision !== 'allow') return false;
      return this.opts.tools.get(call.name)?.concurrencySafe === true;
    };
    let i = 0;
    while (i < decisions.length) {
      if (!isParallelisable(decisions[i]!)) {
        await runOne(decisions[i]!);
        i++;
        continue;
      }
      const batchStart = i;
      while (i < decisions.length && isParallelisable(decisions[i]!)) i++;
      await runBatchInOrder(decisions.slice(batchStart, i));
    }

    const blocks = calls.map((call) => {
      const result = results.get(call.id);
      return {
        type: 'tool_result' as const,
        toolUseId: call.id,
        content: maybeVaryObservation(result, call.id, this.varyObservations),
        ...(result?.isError ? { isError: true } : {}),
      };
    });
    const endsRun = [...results.values()].some((r) => r.endsRun === true);
    return { blocks, endsRun };
  }

  private allowedBySkills(): string[] | undefined {
    return allowedToolNames(this.opts.tools.list(), this.opts.control?.activeSkills);
  }

  /** Decoding constraint for endpoints that accept `allowed_tools`; else undefined. */
  private skillToolChoice(): ToolChoice | undefined {
    const names = this.allowedBySkills();
    if (!names) return undefined;
    const caps = this.opts.model.capabilities;
    if (!caps.nativeTools || !caps.allowedToolsChoice) return undefined;
    return { type: 'allowed_tools', mode: 'auto', names };
  }

  private async executeOne(
    call: ToolUseBlock,
    decision: PermissionDecision,
    truncated = false,
  ): Promise<ToolResult> {
    if (decision.decision === 'deny') {
      return { content: `Denied: ${decision.reason}`, isError: true };
    }
    const allowed = this.allowedBySkills();
    if (allowed && !allowed.some((n) => n.toLowerCase() === call.name.toLowerCase())) {
      return {
        content: `Denied: tool "${call.name}" is not permitted by the active skill's allowed-tools.`,
        isError: true,
      };
    }
    if (call.parseError) {
      return {
        content: truncated
          ? `${TRUNCATED_TOOL_HINT} (parse error: ${call.parseError})`
          : `Could not parse arguments: ${call.parseError}`,
        isError: true,
      };
    }
    const spec = this.opts.tools.get(call.name);
    if (!spec) {
      return { content: `Unknown tool "${call.name}"`, isError: true };
    }
    const parsed = spec.schema.safeParse(call.input);
    if (!parsed.success) {
      return {
        content: `Invalid arguments for ${call.name}: ${parsed.error.message}`,
        isError: true,
      };
    }
    try {
      return await spec.execute(parsed.data, {
        cwd: this.opts.cwd,
        session: this.session,
        ...(this.opts.signal ? { signal: this.opts.signal } : {}),
        ...(this.opts.control ? { control: this.opts.control } : {}),
      });
    } catch (err) {
      return { content: `Tool ${call.name} threw: ${errorMessage(err)}`, isError: true };
    }
  }
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    for (;;) {
      const i = index++;
      if (i >= items.length) return;
      await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
}
