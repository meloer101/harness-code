/**
 * Prompt-encoded tool calling: the fallback path.
 *
 * Plenty of endpoints worth supporting have no `tools` parameter at all —
 * llama.cpp's server, older self-hosted stacks, a proxy someone put in front of
 * a base model. Rather than declaring those out of scope, we describe the tools
 * in the system prompt and parse calls back out of the text stream.
 *
 * The hard part is streaming: the tag markup must never reach the user's
 * terminal, and we only know a `<tool_call>` has begun after we have already
 * been handed some of it. So the parser holds back exactly the suffix that could
 * still turn out to be a tag prefix, and nothing more — visible text stays
 * responsive instead of arriving in one lump at the end.
 */

import { parseLooseJSON } from '../util/json.js';
import type { ToolDefinition, ToolUseBlock } from './types.js';

const OPEN_TAG = '<tool_call>';
const CLOSE_TAG = '</tool_call>';

export function renderToolPrompt(tools: readonly ToolDefinition[]): string {
  const specs = tools
    .map(
      (t) =>
        `### ${t.name}\n${t.description}\n\nParameters (JSON Schema):\n${JSON.stringify(
          t.inputSchema,
        )}`,
    )
    .join('\n\n');

  return `# Tool use

You can call tools. To call one, emit a block in exactly this form:

${OPEN_TAG}
{"name": "<tool name>", "arguments": {<arguments object>}}
${CLOSE_TAG}

Rules:
- The block content must be a single valid JSON object with exactly the keys "name" and "arguments".
- Emit one block per call. To make several calls in one turn, emit several blocks back to back.
- Do not wrap the block in markdown fences and do not add commentary inside it.
- After emitting tool calls, stop. Results are returned to you in the next message.
- If no tool is needed, answer normally and emit no blocks.

## Available tools

${specs}`;
}

export interface ParserOutput {
  /** Text safe to show the user right now (tag markup already removed). */
  text: string;
  /** Calls completed by this chunk. */
  calls: ToolUseBlock[];
}

/**
 * Incremental parser. Feed it text deltas; it returns visible text plus any
 * tool calls that closed. Call `end()` once the stream finishes.
 */
export class PromptToolParser {
  private buffer = '';
  private inCall = false;
  private seq = 0;

  constructor(private readonly idPrefix = 'call') {}

  push(delta: string): ParserOutput {
    this.buffer += delta;
    return this.drain(false);
  }

  end(): ParserOutput {
    const out = this.drain(true);
    if (this.inCall && this.buffer.trim() !== '') {
      // Stream died mid-call (max_tokens, dropped connection). The prefix is
      // usually complete enough that the loose parser can salvage it; a failed
      // salvage still surfaces as a tool_use block carrying its parse error, so
      // the model gets told what went wrong instead of silently losing a turn.
      const call = this.buildCall(this.buffer);
      this.buffer = '';
      this.inCall = false;
      return { text: out.text, calls: [...out.calls, call] };
    }
    if (!this.inCall && this.buffer !== '') {
      const text = out.text + this.buffer;
      this.buffer = '';
      return { text, calls: out.calls };
    }
    return out;
  }

  private drain(flushing: boolean): ParserOutput {
    let text = '';
    const calls: ToolUseBlock[] = [];

    for (;;) {
      if (this.inCall) {
        const close = this.buffer.indexOf(CLOSE_TAG);
        if (close === -1) return { text, calls };
        calls.push(this.buildCall(this.buffer.slice(0, close)));
        this.buffer = this.buffer.slice(close + CLOSE_TAG.length);
        this.inCall = false;
        continue;
      }

      const open = this.buffer.indexOf(OPEN_TAG);
      if (open !== -1) {
        text += this.buffer.slice(0, open);
        this.buffer = this.buffer.slice(open + OPEN_TAG.length);
        this.inCall = true;
        continue;
      }

      // No complete open tag. Release everything except a trailing fragment
      // that could still grow into one.
      const hold = flushing ? 0 : partialTagSuffixLength(this.buffer, OPEN_TAG);
      if (hold === 0) {
        text += this.buffer;
        this.buffer = '';
      } else {
        text += this.buffer.slice(0, this.buffer.length - hold);
        this.buffer = this.buffer.slice(this.buffer.length - hold);
      }
      return { text, calls };
    }
  }

  private buildCall(payload: string): ToolUseBlock {
    const id = `${this.idPrefix}_${++this.seq}`;
    const raw = payload.trim();
    const parsed = parseLooseJSON(raw);

    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
      return {
        type: 'tool_use',
        id,
        name: '',
        input: {},
        rawInput: raw,
        parseError: parsed.error ?? 'tool call payload was not a JSON object',
      };
    }

    const obj = parsed.value as Record<string, unknown>;
    const name = typeof obj['name'] === 'string' ? obj['name'] : '';
    // Models drift between `arguments`, `parameters`, `input` and `args`.
    const args =
      obj['arguments'] ?? obj['parameters'] ?? obj['input'] ?? obj['args'] ?? {};

    const block: ToolUseBlock = {
      type: 'tool_use',
      id,
      name,
      input: typeof args === 'object' && args !== null ? args : {},
      rawInput: raw,
    };
    if (name === '') block.parseError = 'tool call payload had no "name" field';
    return block;
  }
}

/**
 * Length of the longest suffix of `text` that is a proper prefix of `tag`.
 * Zero when nothing at the tail could still become a tag.
 */
export function partialTagSuffixLength(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}
