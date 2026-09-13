/**
 * Best-effort argument coercion for weak models.
 *
 * The loose JSON parser (`util/json.ts`) fixes the *envelope* — a stringified
 * arguments blob, smart quotes, a trailing comma. This fixes the layer above:
 * once we have an object, small models still stringify their scalars
 * (`"true"` for a boolean, `"10"` for a number) or hand back a whole nested
 * object as a JSON string. Strict `safeParse` rejects those, the turn burns on
 * an error-and-retry, and a cheap model may never recover.
 *
 * So we coerce, but only *after* a strict parse has already failed — the happy
 * path (a well-formed call from a capable model) never runs this code and its
 * behaviour is byte-for-byte unchanged. Coercion is schema-guided and
 * conservative: a value is only rewritten when the target type is known and the
 * incoming value is an unambiguous stringified form of it. Anything else is
 * left untouched for `safeParse` to reject with a real error.
 */

import { z } from 'zod';

import { parseLooseJSON } from '../util/json.js';

/** Peel optional/nullable/default wrappers off to the underlying type. */
function baseType(schema: z.ZodType): z.ZodType {
  let s: z.ZodType = schema;
  for (let i = 0; i < 8; i++) {
    if (s instanceof z.ZodOptional || s instanceof z.ZodNullable || s instanceof z.ZodDefault) {
      s = s.unwrap() as z.ZodType;
      continue;
    }
    break;
  }
  return s;
}

function coerceValue(base: z.ZodType, value: unknown): unknown {
  if (base instanceof z.ZodBoolean) {
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (v === 'true') return true;
      if (v === 'false') return false;
    }
    if (value === 1) return true;
    if (value === 0) return false;
    return value;
  }

  if (base instanceof z.ZodNumber) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed);
    }
    return value;
  }

  if (base instanceof z.ZodArray) {
    let arr: unknown = value;
    if (typeof value === 'string') {
      const parsed = parseLooseJSON(value);
      if (parsed.ok && Array.isArray(parsed.value)) arr = parsed.value;
    }
    if (Array.isArray(arr)) {
      const element = baseType(base.element as z.ZodType);
      return arr.map((v) => coerceValue(element, v));
    }
    return value;
  }

  if (base instanceof z.ZodObject) {
    if (typeof value === 'string') {
      const parsed = parseLooseJSON(value);
      if (
        parsed.ok &&
        parsed.value !== null &&
        typeof parsed.value === 'object' &&
        !Array.isArray(parsed.value)
      ) {
        return coerceObject(base, parsed.value as Record<string, unknown>);
      }
      return value;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return coerceObject(base, value as Record<string, unknown>);
    }
    return value;
  }

  // ZodEnum, ZodString, unions, and anything else: leave as-is. Coercing here
  // risks turning a value the model meant literally into the wrong type.
  return value;
}

function coerceObject(
  schema: z.ZodObject,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const shape = schema.shape as Record<string, z.ZodType>;
  const out: Record<string, unknown> = { ...input };
  for (const [key, fieldSchema] of Object.entries(shape)) {
    if (!(key in out)) continue;
    out[key] = coerceValue(baseType(fieldSchema), out[key]);
  }
  return out;
}

/**
 * Return a coerced copy of `input` guided by `schema`, or `input` itself when
 * the schema is not an object schema or there is nothing to coerce. Never
 * throws — coercion is a best-effort assist, and a failure to improve the input
 * just leaves the original error to surface.
 */
export function coerceArgs(schema: z.ZodType, input: unknown): unknown {
  try {
    const base = baseType(schema);
    if (
      base instanceof z.ZodObject &&
      input !== null &&
      typeof input === 'object' &&
      !Array.isArray(input)
    ) {
      return coerceObject(base, input as Record<string, unknown>);
    }
  } catch {
    // Introspection is version-sensitive; if the shape of zod ever shifts under
    // us, degrade to "no coercion" rather than breaking every tool call.
  }
  return input;
}
