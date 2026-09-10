import { describe, expect, it } from 'vitest';

import { methods } from './methods.js';

describe('methods', () => {
  it('server.info and session.list take no params', () => {
    expect(methods['server.info'].params.safeParse(undefined).success).toBe(true);
    expect(methods['session.list'].params.safeParse(undefined).success).toBe(true);
    expect(methods['server.info'].params.safeParse({ oops: true }).success).toBe(false);
  });

  it('session.create accepts an empty object or a valid model/mode, rejects a bad mode', () => {
    const schema = methods['session.create'].params;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ model: 'gpt-5' }).success).toBe(true);
    expect(schema.safeParse({ mode: 'plan' }).success).toBe(true);
    expect(schema.safeParse({ mode: 'not-a-mode' }).success).toBe(false);
  });

  it('session.send requires id and text', () => {
    const schema = methods['session.send'].params;
    expect(schema.safeParse({ id: 's1', text: 'hi' }).success).toBe(true);
    expect(schema.safeParse({ id: 's1' }).success).toBe(false);
    expect(schema.safeParse({ text: 'hi' }).success).toBe(false);
  });

  it('session.subscribe makes sinceSeq optional', () => {
    const schema = methods['session.subscribe'].params;
    expect(schema.safeParse({ id: 's1' }).success).toBe(true);
    expect(schema.safeParse({ id: 's1', sinceSeq: 42 }).success).toBe(true);
    expect(schema.safeParse({ id: 's1', sinceSeq: 'nope' }).success).toBe(false);
  });

  it('ask.answer only accepts the three known decisions', () => {
    const schema = methods['ask.answer'].params;
    expect(schema.safeParse({ sessionId: 's1', askId: 'a1', decision: 'once' }).success).toBe(true);
    expect(schema.safeParse({ sessionId: 's1', askId: 'a1', decision: 'always' }).success).toBe(true);
    expect(schema.safeParse({ sessionId: 's1', askId: 'a1', decision: 'deny' }).success).toBe(true);
    expect(schema.safeParse({ sessionId: 's1', askId: 'a1', decision: 'maybe' }).success).toBe(false);
  });

  it('plan.answer requires approved as a boolean', () => {
    const schema = methods['plan.answer'].params;
    expect(schema.safeParse({ sessionId: 's1', planId: 'p1', approved: true }).success).toBe(true);
    expect(schema.safeParse({ sessionId: 's1', planId: 'p1', approved: 'yes' }).success).toBe(false);
  });
});
