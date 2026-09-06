/**
 * The agent state machine: assemble request -> stream -> collect tool_use ->
 * permission gate -> parallel execute -> refill tool_result -> loop.
 *
 * Policy (what is allowed, how much context to keep, when to compact) is
 * deliberately kept out of this file — it lives behind `AgentHooks` so this
 * loop does not have to change shape as Phase 3/4/6/7 land.
 */

import { estimateCostUSD } from '../provider/capabilities.js';
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
import { allowAllHooks } from './hooks.js';
import type { AgentHooks, PermissionDecision, TurnContext } from './hooks.js';
import { SessionState } from './session.js';
import type { SessionRecorder } from './session.js';

export type AgentStopReason = 'end_turn' | 'max_turns' | 'max_cost' | 'aborted' | 'error';

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call_start'; id: string; name: string; input: unknown }
  | { type: 'tool_call_end'; id: string; name: string; result: ToolResult }
  | { type: 'turn_end'; usage: Usage }
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
  /** Cap on concurrently running read-only tool calls within one turn. */
  concurrency?: number;
  signal?: AbortSignal;
  onEvent?(event: AgentEvent): void;
}

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_CONCURRENCY = 4;

interface Decision {
  call: ToolUseBlock;
  decision: PermissionDecision;
}

export class AgentLoop {
  private readonly hooks: AgentHooks;
  private readonly session: SessionState;
  private readonly maxTurns: number;
  private readonly concurrency: number;

  constructor(private readonly opts: AgentLoopOptions) {
    this.hooks = opts.hooks ?? allowAllHooks;
    this.session = opts.session ?? new SessionState();
    this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  }

  async run(initialMessages: Message[]): Promise<AgentRunResult> {
    const messages: Message[] = [...initialMessages];
    let usage = emptyUsage();
    let costUSD = 0;
    let turn = 0;

    for (;;) {
      turn++;
      if (this.opts.signal?.aborted) return this.stop(messages, usage, 'aborted');
      if (turn > this.maxTurns) return this.stop(messages, usage, 'max_turns');
      if (this.opts.maxCostUSD !== undefined && costUSD > this.opts.maxCostUSD) {
        return this.stop(messages, usage, 'max_cost');
      }

      const turnCtx: TurnContext = { turn, cwd: this.opts.cwd };
      await this.hooks.onBeforeTurn?.(turnCtx);

      const request: ModelRequest = {
        model: this.opts.model.model,
        messages,
        tools: this.opts.tools.definitions(),
        ...(this.opts.system ? { system: this.opts.system } : {}),
        ...(this.opts.signal ? { signal: this.opts.signal } : {}),
      };

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
      const resultBlocks = await this.runToolCalls(calls, turnCtx);
      const userMessage: Message = { role: 'user', content: resultBlocks };
      messages.push(userMessage);
      await this.opts.recorder?.recordMessage(userMessage);
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
  ): Promise<ToolResultBlock[]> {
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
      return spec?.readOnly === true && spec.concurrencySafe;
    });
    const serial = decisions.filter((d) => !parallel.includes(d));

    await runWithConcurrency(parallel, this.concurrency, runOne);
    for (const d of serial) await runOne(d);

    return calls.map((call) => {
      const result = results.get(call.id);
      return {
        type: 'tool_result' as const,
        toolUseId: call.id,
        content: result?.content ?? '',
        ...(result?.isError ? { isError: true } : {}),
      };
    });
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
