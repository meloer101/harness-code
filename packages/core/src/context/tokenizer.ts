/**
 * Token estimation, shared by the provider (for endpoints that report no usage)
 * and the agent loop (for context-window accounting).
 *
 * Nothing here is exact — `js-tiktoken` would be, but the BPE tables only match
 * OpenAI models and this harness talks to a dozen endpoints. The heuristic below
 * is deliberately provider-agnostic and CJK-aware; Phase 4 revisits precision
 * once real `usage` numbers exist to calibrate against.
 */

import type { Message } from '../provider/types.js';

export type TokenCounter = (text: string) => number;

/**
 * Rough token count for endpoints that report no usage at all (Ollama, most
 * llama.cpp builds) and for the loop's context estimate. Weighted because CJK
 * text is far denser per character than the naive chars/4 rule assumes, and
 * this project will be used on both.
 */
export function heuristicTokenCount(text: string): number {
  if (text === '') return 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk++;
    }
  }
  const ascii = text.length - cjk;
  return Math.max(1, Math.ceil(ascii / 4 + cjk * 0.75));
}

/** The subset of a request that carries text weight. */
export interface FlattenableRequest {
  system?: readonly { text: string }[];
  messages: readonly Message[];
  tools?: readonly { description: string; inputSchema: unknown }[];
}

function flattenMessageText(m: Message): string {
  return m.content
    .map((b) =>
      b.type === 'text' || b.type === 'thinking'
        ? b.text
        : b.type === 'tool_result'
          ? b.content
          : JSON.stringify(b.input),
    )
    .join('\n');
}

/**
 * Flatten system + messages + tool schemas into one text blob for estimation.
 * The one implementation of this shape — the provider's `estimateUsage` and the
 * loop's context accounting both call it, so a change to what "counts" only has
 * to happen once.
 */
export function flattenRequestText(req: FlattenableRequest): string {
  const system = (req.system ?? []).map((s) => s.text).join('\n');
  const messages = req.messages.map(flattenMessageText).join('\n');
  const tools = (req.tools ?? [])
    .map((t) => t.description + JSON.stringify(t.inputSchema))
    .join('');
  return system + messages + tools;
}

/** Estimate the token weight of a whole request. Used for the loop's first turn. */
export function estimateRequestTokens(
  req: FlattenableRequest,
  count: TokenCounter = heuristicTokenCount,
): number {
  return count(flattenRequestText(req));
}

/**
 * Estimate the token weight of just these messages — the loop feeds it the
 * tool_result messages appended this turn, so the running context figure only
 * accumulates estimation error on the delta, not the whole history.
 */
export function estimateMessageTokens(
  messages: readonly Message[],
  count: TokenCounter = heuristicTokenCount,
): number {
  return count(messages.map(flattenMessageText).join('\n'));
}
