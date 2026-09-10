/**
 * JSONL progress lines for headless runs.
 *
 * `--output-format json` keeps stdout to one result object; these lines go to
 * stderr so a scripted caller (the Harbor adapter's `hc.log`) can watch a run
 * as it happens instead of reconstructing it from `.agent/traces` afterwards.
 * snake_case, like `ResultJSON`. Token deltas and per-turn context snapshots
 * are deliberately left out — one line per token would drown the log. The
 * shapes are meant to be reused as-is for `--output-format stream-json`.
 */

import { summarizeInput } from '@harness-code/core';
import type { AgentEvent, Notice, Usage } from '@harness-code/core';

export type ProgressLine = { type: string; ts: number } & Record<string, unknown>;

/** Cap on the error text carried by a failed `tool_end` line. */
const ERROR_TEXT_MAX = 500;

/** The progress line for an agent event, or `undefined` for events not streamed. */
export function progressOfEvent(e: AgentEvent, ts = Date.now()): ProgressLine | undefined {
  switch (e.type) {
    case 'tool_call_start':
      return { type: 'tool_start', ts, id: e.id, name: e.name, input: summarizeInput(e.input) };
    case 'tool_call_end':
      return {
        type: 'tool_end',
        ts,
        id: e.id,
        name: e.name,
        is_error: e.result.isError === true,
        output_bytes: Buffer.byteLength(e.result.content ?? '', 'utf8'),
        ...(e.result.isError ? { error: capText(e.result.content ?? '', ERROR_TEXT_MAX) } : {}),
      };
    case 'turn_end':
      return { type: 'turn_end', ts, usage: usageJSON(e.usage) };
    case 'turn_retry':
      return {
        type: 'turn_retry',
        ts,
        attempt: e.attempt,
        max_attempts: e.maxAttempts,
        delay_ms: e.delayMs,
        message: e.message,
      };
    case 'compaction':
      return {
        type: 'compaction',
        ts,
        tokens_before: e.tokensBefore,
        tokens_after: e.tokensAfter,
        kept_turns: e.keptTurns,
      };
    case 'stop':
      return { type: 'stop', ts, reason: e.reason };
    case 'text_delta':
    case 'thinking_delta':
    case 'context':
      return undefined;
  }
}

export function progressOfNotice(n: Notice, ts = Date.now()): ProgressLine {
  return { type: 'notice', ts, kind: n.kind, level: n.level, text: n.text };
}

export function usageJSON(usage: Usage): {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cost_usd?: number;
} {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cached_input_tokens: usage.cachedInputTokens,
    ...(usage.costUSD !== undefined ? { cost_usd: usage.costUSD } : {}),
  };
}

function capText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
