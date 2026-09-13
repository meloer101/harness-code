import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { coerceArgs } from './coerce.js';

describe('coerceArgs', () => {
  it('coerces stringified booleans', () => {
    const schema = z.object({ recursive: z.boolean() });
    expect(coerceArgs(schema, { recursive: 'true' })).toEqual({ recursive: true });
    expect(coerceArgs(schema, { recursive: 'FALSE' })).toEqual({ recursive: false });
    expect(coerceArgs(schema, { recursive: 1 })).toEqual({ recursive: true });
    expect(coerceArgs(schema, { recursive: 0 })).toEqual({ recursive: false });
  });

  it('coerces numeric strings', () => {
    const schema = z.object({ limit: z.number() });
    expect(coerceArgs(schema, { limit: '10' })).toEqual({ limit: 10 });
    expect(coerceArgs(schema, { limit: '3.5' })).toEqual({ limit: 3.5 });
  });

  it('parses a JSON string handed in place of an object or array', () => {
    const schema = z.object({
      opts: z.object({ x: z.boolean() }),
      tags: z.array(z.string()),
    });
    expect(coerceArgs(schema, { opts: '{"x":"true"}', tags: '["a","b"]' })).toEqual({
      opts: { x: true },
      tags: ['a', 'b'],
    });
  });

  it('coerces array elements', () => {
    const schema = z.object({ ids: z.array(z.number()) });
    expect(coerceArgs(schema, { ids: ['1', '2', 3] })).toEqual({ ids: [1, 2, 3] });
  });

  it('sees through optional / nullable / default wrappers', () => {
    const schema = z.object({
      a: z.boolean().optional(),
      b: z.number().nullable(),
      c: z.number().default(7),
    });
    expect(coerceArgs(schema, { a: 'true', b: '5', c: '9' })).toEqual({ a: true, b: 5, c: 9 });
  });

  it('leaves values that are not an unambiguous mismatch untouched', () => {
    const schema = z.object({ name: z.string(), mode: z.enum(['a', 'b']), flag: z.boolean() });
    // strings stay strings; enum stays a string; a genuine boolean is untouched
    expect(coerceArgs(schema, { name: 'true', mode: 'a', flag: true })).toEqual({
      name: 'true',
      mode: 'a',
      flag: true,
    });
  });

  it('does not invent keys the caller omitted', () => {
    const schema = z.object({ a: z.boolean(), b: z.number().optional() });
    expect(coerceArgs(schema, { a: 'true' })).toEqual({ a: true });
  });

  it('returns non-object input and non-object schemas unchanged', () => {
    expect(coerceArgs(z.object({ a: z.boolean() }), 'not-an-object')).toBe('not-an-object');
    expect(coerceArgs(z.string(), 'x')).toBe('x');
    expect(coerceArgs(z.object({ a: z.boolean() }), null)).toBe(null);
  });

  it('leaves a value alone when its stringified form does not parse', () => {
    const schema = z.object({ limit: z.number() });
    expect(coerceArgs(schema, { limit: 'abc' })).toEqual({ limit: 'abc' });
  });
});
