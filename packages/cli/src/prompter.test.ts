import { PassThrough, Writable } from 'node:stream';
import { createInterface } from 'node:readline';

import { describe, expect, it } from 'vitest';

import { createPrompter, interactiveAskHandler } from './prompter.js';
import type { Prompter } from './prompter.js';

function harness() {
  const input = new PassThrough();
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const rl = createInterface({ input, output, terminal: false });
  const prompter = createPrompter(rl);
  return {
    prompter,
    send: (line: string) => input.write(`${line}\n`),
    out: () => chunks.join(''),
    close: () => rl.close(),
  };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('ReadlinePrompter.confirm', () => {
  it('maps "y" to allow-once', async () => {
    const h = harness();
    const p = h.prompter.confirm({ title: 'Bash requires approval', detail: 'npm test', alwaysLabel: 'Bash' });
    await tick();
    h.send('y');
    expect(await p).toEqual({ choice: 'once' });
    h.close();
  });

  it('maps "a" to always', async () => {
    const h = harness();
    const p = h.prompter.confirm({ title: 'T', detail: 'd' });
    await tick();
    h.send('a');
    expect(await p).toEqual({ choice: 'always' });
    h.close();
  });

  it('treats "n" as deny and captures the follow-up reason', async () => {
    const h = harness();
    const p = h.prompter.confirm({ title: 'T', detail: 'd' });
    await tick();
    h.send('n');
    await tick();
    h.send('do not touch prod');
    expect(await p).toEqual({ choice: 'deny', feedback: 'do not touch prod' });
    h.close();
  });

  it('deny with an empty reason omits feedback', async () => {
    const h = harness();
    const p = h.prompter.confirm({ title: 'T', detail: 'd' });
    await tick();
    h.send('n');
    await tick();
    h.send('');
    expect(await p).toEqual({ choice: 'deny' });
    h.close();
  });

  it('settles as deny when the signal is already aborted, without reading input', async () => {
    const h = harness();
    const res = await h.prompter.confirm({
      title: 'T',
      detail: 'd',
      signal: AbortSignal.abort(),
    });
    expect(res.choice).toBe('deny');
    expect(res.feedback).toBe('用户中断');
    h.close();
  });

  it('serializes concurrent prompts — the second is not shown until the first is answered', async () => {
    const h = harness();
    const a = h.prompter.confirm({ title: 'FIRST', detail: 'a' });
    const b = h.prompter.confirm({ title: 'SECOND', detail: 'b' });
    await tick();

    expect(h.out()).toContain('FIRST');
    expect(h.out()).not.toContain('SECOND');

    h.send('y');
    expect(await a).toEqual({ choice: 'once' });
    await tick();

    expect(h.out()).toContain('SECOND');
    h.send('n');
    await tick();
    h.send('');
    await b;
    h.close();
  });
});

describe('interactiveAskHandler', () => {
  const fakePrompter = (result: Awaited<ReturnType<Prompter['confirm']>>): Prompter => ({
    confirm: async () => result,
    askText: async () => '',
    close: () => {},
  });

  it('"once" -> allow', async () => {
    const engine = { addAllowRule: () => {} };
    const ask = interactiveAskHandler(engine, fakePrompter({ choice: 'once' }));
    expect(await ask({ toolName: 'bash', input: { command: 'ls' }, reason: 'r' })).toEqual({
      decision: 'allow',
    });
  });

  it('"always" -> allow and appends a whole-tool rule', async () => {
    const added: string[] = [];
    const engine = { addAllowRule: (r: string) => added.push(r) };
    const echoed: string[] = [];
    const ask = interactiveAskHandler(engine, fakePrompter({ choice: 'always' }), {
      echo: (l) => echoed.push(l),
    });
    expect(await ask({ toolName: 'bash', input: {}, reason: 'r' })).toEqual({ decision: 'allow' });
    expect(added).toEqual(['Bash']);
    expect(echoed[0]).toContain('allow Bash');
  });

  it('"deny" -> deny, threading the feedback into the reason for the model', async () => {
    const engine = { addAllowRule: () => {} };
    const ask = interactiveAskHandler(engine, fakePrompter({ choice: 'deny', feedback: 'use the test db' }));
    const d = await ask({ toolName: 'bash', input: {}, reason: 'r' });
    expect(d.decision).toBe('deny');
    if (d.decision === 'deny') expect(d.reason).toContain('use the test db');
  });
});
