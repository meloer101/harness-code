/**
 * Tolerant JSON parsing for model output.
 *
 * Tool-call arguments arrive from the model, not from a compiler. Strict
 * `JSON.parse` is the right default and the wrong only-option: a single trailing
 * comma from a 7B model should not abort a turn that is otherwise correct. Every
 * repair here is recorded so callers can tell a clean parse from a salvaged one.
 */

export interface LooseParseResult {
  ok: boolean;
  value: unknown;
  /** Repairs applied, in order. Empty means the input was already valid JSON. */
  repairs: string[];
  error?: string;
}

export function parseLooseJSON(input: string): LooseParseResult {
  const repairs: string[] = [];
  let text = input.trim();

  if (text === '') return { ok: true, value: {}, repairs: ['empty-to-object'] };

  // 1. Strict first. The overwhelmingly common case; never pay for repairs.
  const strict = tryParse(text);
  if (strict.ok) return { ok: true, value: strict.value, repairs };

  // 2. Strip markdown fences: ```json { ... } ```
  const fenced = /^```(?:[a-zA-Z]*\s*)?\n?([\s\S]*?)\n?```$/.exec(text);
  if (fenced?.[1] !== undefined) {
    text = fenced[1].trim();
    repairs.push('strip-code-fence');
    const r = tryParse(text);
    if (r.ok) return { ok: true, value: r.value, repairs };
  }

  // 3. Carve out the first balanced object/array. Handles models that wrap the
  //    payload in prose ("Sure! Here are the arguments: {...}").
  const carved = extractBalanced(text);
  if (carved !== undefined && carved !== text) {
    text = carved;
    repairs.push('extract-balanced');
    const r = tryParse(text);
    if (r.ok) return { ok: true, value: r.value, repairs };
  }

  // 4. Normalize characters that look like JSON but are not: smart quotes from
  //    models that have been RLHF'd into typography, and Python literals.
  const normalized = normalizeLiterals(text);
  if (normalized !== text) {
    text = normalized;
    repairs.push('normalize-literals');
    const r = tryParse(text);
    if (r.ok) return { ok: true, value: r.value, repairs };
  }

  // 5. Trailing commas before a closer.
  const decommaed = text.replace(/,(\s*[}\]])/g, '$1');
  if (decommaed !== text) {
    text = decommaed;
    repairs.push('trailing-comma');
    const r = tryParse(text);
    if (r.ok) return { ok: true, value: r.value, repairs };
  }

  // 6. Truncated output: close whatever is still open. This is the single most
  //    valuable repair in practice, because hitting max_tokens mid-arguments is
  //    common and the prefix is usually complete enough to act on.
  const closed = closeOpenStructures(text);
  if (closed !== text) {
    text = closed;
    repairs.push('close-truncated');
    const r = tryParse(text);
    if (r.ok) return { ok: true, value: r.value, repairs };
  }

  // 7. Last resort: single-quoted keys/strings, as long as the text contains no
  //    double quotes that would make the rewrite ambiguous.
  if (!text.includes('"') && text.includes("'")) {
    const requoted = text.replace(/'/g, '"');
    repairs.push('single-to-double-quotes');
    const r = tryParse(requoted);
    if (r.ok) return { ok: true, value: r.value, repairs };
  }

  return {
    ok: false,
    value: undefined,
    repairs,
    error: strict.error ?? 'unparseable',
  };
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function normalizeLiterals(text: string): string {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\bNone\b/g, 'null')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false');
}

/** Return the first balanced `{...}` or `[...]` region, string-aware. */
function extractBalanced(text: string): string | undefined {
  const start = firstIndexOfAny(text, ['{', '[']);
  if (start === -1) return undefined;

  const open = text[start] as '{' | '[';
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/** Close a truncated JSON value by appending the missing terminators. */
function closeOpenStructures(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const ch of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }

  if (!inString && stack.length === 0) return text;

  let out = text;
  // A dangling escape would swallow our closing quote.
  if (escaped) out = out.slice(0, -1);
  if (inString) out += '"';
  // Drop a trailing `"key":` or `,` that has no value to complete.
  out = out.replace(/,\s*$/, '').replace(/[,{[]?\s*"[^"]*"\s*:\s*$/, (m) =>
    m.trimStart().startsWith(',') ? '' : m.slice(0, m.indexOf('"')),
  );
  for (let i = stack.length - 1; i >= 0; i--) {
    out += stack[i] === '{' ? '}' : ']';
  }
  return out;
}

function firstIndexOfAny(text: string, chars: string[]): number {
  let best = -1;
  for (const c of chars) {
    const i = text.indexOf(c);
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  return best;
}

/** Stable stringify for cache keys and fixture comparison. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
