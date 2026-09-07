/**
 * The agent state machine: assemble request -> stream -> collect tool_use ->
 * permission gate -> parallel execute -> refill tool_result -> loop.
 *
 * Policy (what is allowed, how much context to keep, when to compact) is
 * deliberately kept out of this file — it lives behind `AgentHooks` so this
 * loop does not have to change shape as Phase 3/4/6/7 land.
 */

import { estimateCostUSD } from '../provider/capabilities.js';
import { analyzeStableParts, breakdownFrom } from '../context/budget.js';
import { estimateMessageTokens, estimateRequestTokens } from '../context/tokenizer.js';
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
  SystemSegment,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
} from '../provider/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolResult } from '../tools/types.js';
import { errorMessage } from '../tools/util.js';
import type { ContextBreakdown } from '../context/budget.js';
import { allowAllHooks } from './hooks.js';
import type { AgentHooks, PermissionDecision, TurnContext } from './hooks.js';
import type { AgentControl } from './control.js';
import { SessionState } from './session.js';
import type { SessionRecorder } from './session.js';

export type AgentStopReason =
  | 'end_turn'
  | 'max_turns'
  | 'max_cost'
  | 'max_tokens'
  | 'context_limit'
  | 'stopped_by_tool'
  | 'aborted'
  | 'error';

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call_start'; id: string; name: string; input: unknown }
  | { type: 'tool_call_end'; id: string; name: string; result: ToolResult }
  | { type: 'turn_end'; usage: Usage }
  | {
      type: 'context';
      usedTokens: number;
      windowTokens: number;
      ratio: number;
      breakdown: ContextBreakdown;
    }
  | { type: 'compaction'; tokensBefore: number; tokensAfter: number; keptTurns: number }
  | { type: 'stop'; reason: AgentStopReason };

export interface AgentRunResult {
  messages: Message[];
  usage: Usage;
  stopReason: AgentStopReason;
}

export interface AgentLoopOptions {
  model: ResolvedModel;
  tools: ToolRegistry;
  cwd: string;
  system?: SystemSegment[];
  session?: SessionState;
  recorder?: SessionRecorder;
  hooks?: AgentHooks;
  maxTurns?: number;
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
  signal?: AbortSignal;
  /** Passed through to every tool's `ctx.control`. */
  control?: AgentControl;
  onEvent?(event: AgentEvent): void;
}

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_CONCURRENCY = 4;
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

  constructor(private readonly opts: AgentLoopOptions) {
    this.hooks = opts.hooks ?? allowAllHooks;
    this.session = opts.session ?? new SessionState();
    this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
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
    const stableParts = analyzeStableParts({
      system: this.opts.system,
      tools: this.opts.tools.definitions(),
    });
    // Anchored on the endpoint's real `usage` from the previous turn, so
    // estimation error only accrues on the tool_result messages we appended
    // since — not on a full-history heuristic pass every turn.
    let prevUsage: Usage | undefined;
    let appendedTokens = 0;

    for (;;) {
      turn++;
      if (this.opts.signal?.aborted) return this.stop(messages, usage, 'aborted');
      if (turn > this.maxTurns) return this.stop(messages, usage, 'max_turns');
      if (this.opts.maxCostUSD !== undefined && costUSD > this.opts.maxCostUSD) {
        return this.stop(messages, usage, 'max_cost');
      }

      const turnCtx: TurnContext = {
        turn,
        cwd: this.opts.cwd,
        ...(this.opts.signal ? { signal: this.opts.signal } : {}),
      };
      await this.hooks.onBeforeTurn?.(turnCtx);

      const request: ModelRequest = {
        model: this.opts.model.model,
        messages,
        tools: this.opts.tools.definitions(),
        maxOutputTokens: this.maxOutputTokens,
        ...(this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : {}),
        ...(this.opts.system ? { system: this.opts.system } : {}),
        ...(this.opts.signal ? { signal: this.opts.signal } : {}),
      };

      if (
        this.opts.maxTokens !== undefined &&
        usage.inputTokens + usage.outputTokens > this.opts.maxTokens
      ) {
        return this.stop(messages, usage, 'max_tokens');
      }

      let contextTokens =
        prevUsage === undefined
          ? estimateRequestTokens(request)
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
          const before = contextTokens;
          messages.length = 0;
          messages.push(...compacted.messages);
          if (compacted.usage) {
            usage = addUsage(usage, compacted.usage);
            const pricing = this.opts.model.capabilities.pricing;
            if (pricing) costUSD += estimateCostUSD(compacted.usage, pricing) ?? 0;
          }
          prevUsage = undefined;
          appendedTokens = 0;
          contextTokens = estimateRequestTokens({ ...request, messages });
          ratio = contextTokens / availableWindow;
          this.emit({
            type: 'compaction',
            tokensBefore: before,
            tokensAfter: contextTokens,
            keptTurns: compacted.keptTurns ?? 0,
          });
          await this.opts.recorder?.recordCompaction([...messages], {
            tokensBefore: before,
            tokensAfter: contextTokens,
            keptTurns: compacted.keptTurns ?? 0,
          });
        }
      }

      this.emit({
        type: 'context',
        usedTokens: contextTokens,
        windowTokens: availableWindow,
        ratio,
        breakdown: breakdownFrom(stableParts, contextTokens),
      });

      if (ratio >= this.contextStopRatio) {
        return this.stop(messages, usage, 'context_limit');
      }
      if (ratio >= this.contextWarnRatio) {
        await this.hooks.onContextPressure?.(turnCtx, {
          usedTokens: contextTokens,
          windowTokens: availableWindow,
          ratio,
        });
      }

      let response: ModelResponse;
      try {
        response = await this.streamTurn(request);
      } catch (err) {
        if (err instanceof ProviderError && err.kind === 'aborted') {
          return this.stop(messages, usage, 'aborted');
        }
        throw err;
      }

      usage = addUsage(usage, response.usage);
      const pricing = this.opts.model.capabilities.pricing;
      if (pricing) costUSD += estimateCostUSD(response.usage, pricing) ?? 0;
      this.emit({ type: 'turn_end', usage: response.usage });

      const assistantMessage: Message = { role: 'assistant', content: response.content };
      messages.push(assistantMessage);
      await this.opts.recorder?.recordMessage(assistantMessage);

      if (response.stopReason !== 'tool_use') {
        return this.stop(messages, usage, 'end_turn');
      }

      const calls = toolUsesOf(response.content);
      const { blocks, endsRun } = await this.runToolCalls(calls, turnCtx);
      const userMessage: Message = { role: 'user', content: blocks };
      messages.push(userMessage);
      await this.opts.recorder?.recordMessage(userMessage);

      if (endsRun) return this.stop(messages, usage, 'stopped_by_tool');

      prevUsage = response.usage;
      appendedTokens = estimateMessageTokens([userMessage]);
    }
  }

  private stop(messages: Message[], usage: Usage, reason: AgentStopReason): AgentRunResult {
    this.emit({ type: 'stop', reason });
    return { messages, usage, stopReason: reason };
  }

  private emit(event: AgentEvent): void {
    this.opts.onEvent?.(event);
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
  ): Promise<{ blocks: ToolResultBlock[]; endsRun: boolean }> {
    const decisions: Decision[] = await Promise.all(
      calls.map(async (call) => ({
        call,
        decision: (await this.hooks.onBeforeToolCall?.(call, turnCtx)) ?? { decision: 'allow' },
      })),
    );

    const results = new Map<string, ToolResult>();
    const runOne = async ({ call, decision }: Decision): Promise<void> => {
      this.emit({ type: 'tool_call_start', id: call.id, name: call.name, input: call.input });
      const result = await this.executeOne(call, decision);
      results.set(call.id, result);
      this.emit({ type: 'tool_call_end', id: call.id, name: call.name, result });
      await this.hooks.onAfterToolCall?.(call, result, turnCtx);
      await this.opts.recorder?.recordToolCall({
        id: call.id,
        name: call.name,
        input: call.input,
        result,
      });
    };

    const parallel = decisions.filter(({ call, decision }) => {
      if (decision.decision !== 'allow') return false;
      const spec = this.opts.tools.get(call.name);
      // `concurrencySafe` is the contract — a write tool that is unsafe to
      // interleave declares `false` (all of them currently do). `task` is
      // concurrency-safe though not read-only, so parallel sub-agents work.
      return spec?.concurrencySafe === true;
    });
    const serial = decisions.filter((d) => !parallel.includes(d));

    await runWithConcurrency(parallel, this.concurrency, runOne);
    for (const d of serial) await runOne(d);

    const blocks = calls.map((call) => {
      const result = results.get(call.id);
      return {
        type: 'tool_result' as const,
        toolUseId: call.id,
        content: result?.content ?? '',
        ...(result?.isError ? { isError: true } : {}),
      };
    });
    const endsRun = [...results.values()].some((r) => r.endsRun === true);
    return { blocks, endsRun };
  }

  private async executeOne(call: ToolUseBlock, decision: PermissionDecision): Promise<ToolResult> {
    if (decision.decision === 'deny') {
      return { content: `Denied: ${decision.reason}`, isError: true };
    }
    if (call.parseError) {
      return { content: `Could not parse arguments: ${call.parseError}`, isError: true };
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
