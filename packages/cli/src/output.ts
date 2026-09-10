/**
 * Output sinks: render an agent session to a terminal or to structured JSON.
 *
 * `TextSink` is the ANSI renderer that used to live inline in the CLI's `agent`
 * action — plain `\x1b[…m`, no chalk (the "no chalk" rule applies to
 * scriptable `hc` output). `JsonSink` buffers the assistant text and emits one
 * snake_case object at `finish()`, deliberately close to Claude Code's
 * `--output-format json` shape so `jq` snippets transfer; with `progress` on
 * it also streams JSONL progress lines (`progress.ts`) to stderr.
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
import { describeStop, isErrorStop, printUsage } from './format.js';
import { progressOfEvent, progressOfNotice, usageJSON } from './progress.js';
import { interactiveAskHandler } from './prompter.js';
import type { Prompter } from './prompter.js';
import { StreamJsonSink } from './stream-json.js';

export interface FinishInfo {
  sessionId: string;
  stopReason: string;
  turns: number;
  usage?: Usage;
  isError?: boolean;
  /** Set when the run died on an error rather than reaching a stop reason. */
  error?: { message: string; kind?: string };
}

/** A run that threw instead of returning — `sessionId` is empty if the session never started. */
export interface FailInfo {
  sessionId: string;
  turns: number;
  usage?: Usage;
  context?: ContextSnapshot;
  error: { message: string; kind?: string };
}

export interface OutputSink {
  /**
   * Optional: session is ready. Used by `stream-json` to emit `thread.started`
   * before the first model event.
   */
  start?(sessionId: string): void;
  event(e: AgentEvent): void;
  notice(n: Notice): void;
  turn(modelRef: string, r: AgentRunResult, context?: ContextSnapshot): void;
  finish(info: FinishInfo): void;
  /**
   * The run threw. The caller still re-throws so the error is printed and the
   * exit code is non-zero; this is the sink's chance to leave its own record
   * (for `JsonSink`, the one stdout result object a scripted caller relies on).
   */
  fail(info: FailInfo): void;
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

  /** The error itself is printed by `main()`; just leave the session id for `--resume`. */
  fail(info: FailInfo): void {
    this.flushThinking();
    if (info.sessionId) {
      process.stderr.write(`\x1b[2msession ${info.sessionId} · stop: error\x1b[0m\n`);
    }
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
  /** Present only when the run died on an error (`stop_reason: "error"`). */
  error?: { message: string; kind?: string };
}

export interface JsonSinkOptions {
  /** Stream JSONL progress lines (tool calls, turns, notices) to stderr while running. */
  progress?: boolean;
}

export class JsonSink implements OutputSink {
  /** Text from completed model calls. */
  private committed = '';
  /** Text streamed by the in-flight model call — dropped if that call is retried. */
  private pending = '';
  private isError = false;
  private usage?: Usage;
  private context?: ContextSnapshot;

  constructor(private readonly opts: JsonSinkOptions = {}) {}

  event(e: AgentEvent): void {
    if (this.opts.progress) {
      const line = progressOfEvent(e);
      if (line) {
        if (e.type === 'turn_end') line.text_chars = this.pending.length;
        writeLine(line);
      }
    }
    switch (e.type) {
      case 'text_delta':
        this.pending += e.text;
        break;
      case 'turn_retry':
        this.pending = '';
        break;
      case 'turn_end':
        this.committed += this.pending;
        this.pending = '';
        break;
      case 'tool_call_end':
        if (e.result.isError) this.isError = true;
        break;
      default:
        break;
    }
  }

  notice(n: Notice): void {
    if (this.opts.progress) writeLine(progressOfNotice(n));
  }

  turn(_modelRef: string, r: AgentRunResult, context?: ContextSnapshot): void {
    this.usage = r.usage;
    this.context = context;
  }

  finish(info: FinishInfo): void {
    process.stdout.write(
      JSON.stringify(
        toResultJSON(
          info,
          this.committed + this.pending,
          this.usage,
          this.context,
          this.isError || info.isError === true || isErrorStop(info.stopReason),
        ),
      ) + '\n',
    );
  }

  fail(info: FailInfo): void {
    // The model call in flight when the run died never completed: its partial
    // text is void, exactly like a retried attempt's.
    this.pending = '';
    if (this.opts.progress) {
      writeLine({ type: 'error', ts: Date.now(), ...info.error });
    }
    this.usage = info.usage;
    this.context = info.context;
    this.finish({
      sessionId: info.sessionId,
      stopReason: 'error',
      turns: info.turns,
      isError: true,
      error: info.error,
    });
  }
}

function writeLine(line: object): void {
  process.stderr.write(`${JSON.stringify(line)}\n`);
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
  if (usage) out.usage = usageJSON(usage);
  if (info.error) out.error = info.error;
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

export function createSink(
  format: 'text' | 'json' | 'stream-json',
  modelRef: string,
  opts: JsonSinkOptions = {},
): OutputSink {
  switch (format) {
    case 'text':
      return new TextSink(modelRef);
    case 'json':
      return new JsonSink(opts);
    case 'stream-json':
      return new StreamJsonSink(modelRef);
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
