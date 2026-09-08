/**
 * Output sinks: render an agent session to a terminal or to structured JSON.
 *
 * `TextSink` is the ANSI renderer that used to live inline in the CLI's `agent`
 * action — plain `\x1b[…m`, no chalk (the "no chalk" rule applies to
 * scriptable `hc` output). `JsonSink` buffers the assistant text and emits one
 * snake_case object at `finish()`, deliberately close to Claude Code's
 * `--output-format json` shape so `jq` snippets transfer.
 */

import { cacheHitRate } from '@harness-code/core';
import type {
  AgentEvent,
  AgentRunResult,
  AskHandler,
  ContextSnapshot,
  Notice,
  Usage,
} from '@harness-code/core';
import type { AgentSession } from '@harness-code/core';
import { describeStop, printUsage } from './format.js';
import { interactiveAskHandler } from './prompter.js';
import type { Prompter } from './prompter.js';

export interface FinishInfo {
  sessionId: string;
  stopReason: string;
  turns: number;
  usage?: Usage;
  isError?: boolean;
}

export interface OutputSink {
  event(e: AgentEvent): void;
  notice(n: Notice): void;
  turn(modelRef: string, r: AgentRunResult, context?: ContextSnapshot): void;
  finish(info: FinishInfo): void;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export class TextSink implements OutputSink {
  private thinkingOpen = false;

  constructor(private readonly modelRef: string) {}

  event(e: AgentEvent): void {
    switch (e.type) {
      case 'thinking_delta':
        if (!this.thinkingOpen) {
          process.stderr.write('\x1b[2m[thinking] ');
          this.thinkingOpen = true;
        }
        process.stderr.write(e.text);
        break;
      case 'text_delta':
        this.flushThinking();
        process.stdout.write(e.text);
        break;
      case 'tool_call_start':
        process.stdout.write(`\n[tool_use ${e.name}] ${JSON.stringify(e.input)}\n`);
        break;
      case 'tool_call_end':
        if (e.result.isError) {
          process.stderr.write(`\x1b[31m[tool_error ${e.name}] ${e.result.content}\x1b[0m\n`);
        } else if (e.name === 'exit_plan_mode') {
          this.flushThinking();
          process.stderr.write(`\x1b[2m${e.result.content}\x1b[0m\n`);
        } else if (e.name === 'task') {
          this.flushThinking();
          process.stderr.write('\x1b[2m  ⤷ report:\x1b[0m\n');
          process.stderr.write(
            e.result.content
              .split('\n')
              .map((l) => `\x1b[2m  │ ${l}\x1b[0m`)
              .join('\n') + '\n',
          );
        }
        break;
      default:
        break;
    }
  }

  notice(n: Notice): void {
    this.flushThinking();
    const color = n.level === 'error' ? '\x1b[31m' : n.level === 'warn' ? '\x1b[33m' : '\x1b[2m';
    process.stderr.write(`${color}${n.text}\x1b[0m\n`);
  }

  /** Close a half-open dim `[thinking]` block so following output isn't grey. */
  flushThinking(): void {
    if (this.thinkingOpen) {
      process.stderr.write('\x1b[0m\n');
      this.thinkingOpen = false;
    }
  }

  /** A dim status line — the ask handler's "+ allow X" confirmation lands here. */
  dim(line: string): void {
    process.stderr.write(`\x1b[2m${line}\x1b[0m\n`);
  }

  turn(_modelRef: string, r: AgentRunResult, context?: ContextSnapshot): void {
    process.stdout.write('\n');
    printUsage(this.modelRef, r.usage, undefined, undefined, context);
    const note = describeStop(r.stopReason);
    if (note) process.stderr.write(`\x1b[2m${note}\x1b[0m\n`);
  }

  finish(info: FinishInfo): void {
    this.flushThinking();
    process.stderr.write(
      `\x1b[2msession ${info.sessionId} · stop: ${info.stopReason}${cacheSummaryOf(info.usage)}\x1b[0m\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export interface ResultJSON {
  type: 'result';
  session_id: string;
  stop_reason: string;
  turns: number;
  result: string;
  is_error: boolean;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    cost_usd?: number;
  };
  context?: {
    used_tokens: number;
    window_tokens: number;
    ratio: number;
  };
}

export class JsonSink implements OutputSink {
  private text = '';
  private isError = false;
  private usage?: Usage;
  private context?: ContextSnapshot;

  event(e: AgentEvent): void {
    if (e.type === 'text_delta') this.text += e.text;
    else if (e.type === 'tool_call_end' && e.result.isError) this.isError = true;
  }

  notice(_n: Notice): void {}

  turn(_modelRef: string, r: AgentRunResult, context?: ContextSnapshot): void {
    this.usage = r.usage;
    this.context = context;
  }

  finish(info: FinishInfo): void {
    process.stdout.write(
      JSON.stringify(
        toResultJSON(info, this.text, this.usage, this.context, this.isError || info.isError === true),
      ) + '\n',
    );
  }
}

export function toResultJSON(
  info: FinishInfo,
  text: string,
  usage?: Usage,
  context?: ContextSnapshot,
  isError = false,
): ResultJSON {
  const out: ResultJSON = {
    type: 'result',
    session_id: info.sessionId,
    stop_reason: info.stopReason,
    turns: info.turns,
    result: text.trim(),
    is_error: isError,
  };
  if (usage) {
    out.usage = {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cached_input_tokens: usage.cachedInputTokens,
      ...(usage.costUSD !== undefined ? { cost_usd: usage.costUSD } : {}),
    };
  }
  if (context) {
    out.context = {
      used_tokens: context.usedTokens,
      window_tokens: context.windowTokens,
      ratio: context.ratio,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Factory + ask wiring
// ---------------------------------------------------------------------------

export function createSink(format: 'text' | 'json' | 'stream-json', modelRef: string): OutputSink {
  switch (format) {
    case 'text':
      return new TextSink(modelRef);
    case 'json':
      return new JsonSink();
    case 'stream-json':
      throw new Error('--output-format stream-json is not implemented yet (deferred to v1.1)');
  }
}

/**
 * Build the interactive ask handler for a TTY frontend. `getSession` is lazy
 * because the session doesn't exist until after `AgentSession.create` — and the
 * ask handler is an *input* to that create. The closure dereferences it on the
 * first actual permission check, by which point it is assigned.
 */
export function interactiveAsk(
  getSession: () => AgentSession,
  prompter: Prompter,
  sink: TextSink,
): AskHandler {
  return interactiveAskHandler(
    { addAllowRule: (raw) => getSession().engine.addAllowRule(raw) },
    prompter,
    { onBeforePrompt: () => sink.flushThinking(), echo: (line) => sink.dim(line) },
  );
}

function cacheSummaryOf(usage: Usage | undefined): string {
  if (!usage || usage.inputTokens === 0 || usage.cachedInputTokens === 0) return '';
  return ` · cache ${Math.round(cacheHitRate(usage) * 100)}% of ${usage.inputTokens} input tokens`;
}
