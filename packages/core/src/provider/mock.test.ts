import { describe, expect, it } from 'vitest';

import {
  ReplayProvider,
  ScriptedProvider,
  pathExpander,
  pathRedactor,
  requestKey,
} from './mock.js';
import { drainStream } from './types.js';
import type { ModelRequest } from './types.js';

const req: ModelRequest = {
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
};

describe('ScriptedProvider', () => {
  it('returns scripted turns in order and records the requests', async () => {
    const p = new ScriptedProvider([
      { toolCalls: [{ name: 'read', input: { path: 'a.ts' } }] },
      { text: 'done' },
    ]);

    const first = await drainStream(p.stream(req));
    expect(first.stopReason).toBe('tool_use');
    expect(first.content[0]).toMatchObject({ name: 'read' });

    const second = await drainStream(p.stream(req));
    expect(second.stopReason).toBe('end_turn');
    expect(p.requests).toHaveLength(2);
  });

  it('fails clearly when the code under test calls the model too often', async () => {
    const p = new ScriptedProvider([{ text: 'only one' }]);
    await drainStream(p.stream(req));
    await expect(drainStream(p.stream(req))).rejects.toThrow(/ran out of turns/);
  });

  it('splits text into deltas so streaming consumers get exercised', async () => {
    const p = new ScriptedProvider([{ text: 'abcdef', chunkSize: 2 }]);
    const deltas: string[] = [];
    for await (const ev of p.stream(req)) {
      if (ev.type === 'text_delta') deltas.push(ev.text);
    }
    expect(deltas).toEqual(['ab', 'cd', 'ef']);
  });
});

describe('requestKey', () => {
  it('ignores fields that cannot change the answer', () => {
    const a = requestKey({ ...req, signal: new AbortController().signal });
    const b = requestKey({ ...req });
    expect(a).toBe(b);
  });

  it('changes when the conversation changes', () => {
    const other: ModelRequest = {
      ...req,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'different' }] }],
    };
    expect(requestKey(req)).not.toBe(requestKey(other));
  });

  it('is stable across workspace paths when a redactor scrubs them', () => {
    const atA: ModelRequest = {
      model: 'm',
      system: [{ id: 'environment', text: 'Working directory: /tmp/hc-eval-aaa' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'see /tmp/hc-eval-aaa/src/x.ts' }] },
      ],
    };
    const atB: ModelRequest = {
      model: 'm',
      system: [{ id: 'environment', text: 'Working directory: /var/folders/z/hc-eval-bbb' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'see /var/folders/z/hc-eval-bbb/src/x.ts' }] },
      ],
    };
    expect(requestKey(atA, pathRedactor(['/tmp/hc-eval-aaa']))).toBe(
      requestKey(atB, pathRedactor(['/var/folders/z/hc-eval-bbb'])),
    );
    // …but a real content difference still shows through the redactor.
    expect(requestKey(atA, pathRedactor(['/tmp/hc-eval-aaa']))).not.toBe(requestKey(atA));
  });
});

describe('pathRedactor / pathExpander', () => {
  it('replaces the longest matching path first', () => {
    const redact = pathRedactor(['/work', '/work/pkg']);
    expect(redact('/work/pkg/a and /work/b')).toBe('$HC_WORKSPACE/a and $HC_WORKSPACE/b');
  });

  it('is identity with no paths', () => {
    expect(pathRedactor([])('/work/a')).toBe('/work/a');
  });

  it('round-trips a path through redact then expand', () => {
    const redact = pathRedactor(['/rec/work']);
    const expand = pathExpander('/replay/work');
    expect(expand(redact('read /rec/work/src/x.ts'))).toBe('read /replay/work/src/x.ts');
  });
});

describe('ReplayProvider', () => {
  it('replays a recorded exchange for a matching request', async () => {
    const provider = ReplayProvider.fromEntries([
      {
        key: requestKey(req),
        note: 'test',
        events: [
          { type: 'message_start', model: 'm' },
          { type: 'text_delta', text: 'recorded' },
          {
            type: 'message_end',
            response: {
              model: 'm',
              content: [{ type: 'text', text: 'recorded' }],
              stopReason: 'end_turn',
              usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
            },
          },
        ],
      },
    ]);

    const res = await drainStream(provider.stream(req));
    expect(res.content).toEqual([{ type: 'text', text: 'recorded' }]);
  });

  it('refuses to guess when the prompt has drifted from the recording', async () => {
    const provider = ReplayProvider.fromEntries([
      { key: 'stale-key', note: 'test', events: [] },
    ]);
    await expect(drainStream(provider.stream(req))).rejects.toThrow(/No recorded response/);
  });

  it('substitutes this run\'s workspace path back into a recorded tool call', async () => {
    const atReplay: ModelRequest = {
      model: 'm',
      system: [{ id: 'environment', text: 'Working directory: /replay/wd' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'fix it' }] }],
    };
    // Recorded under /rec/wd, stored with the sentinel.
    const provider = ReplayProvider.fromEntries(
      [
        {
          key: requestKey(atReplay, pathRedactor(['/replay/wd'])),
          note: 'test',
          events: [
            {
              type: 'message_end',
              response: {
                model: 'm',
                content: [
                  {
                    type: 'tool_use',
                    id: 't1',
                    name: 'read',
                    input: { path: '$HC_WORKSPACE/src/x.ts' },
                  },
                ],
                stopReason: 'tool_use',
                usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
              },
            },
          ],
        },
      ],
      { redactPaths: ['/replay/wd'] },
    );

    const res = await drainStream(provider.stream(atReplay));
    expect(res.content[0]).toMatchObject({ name: 'read', input: { path: '/replay/wd/src/x.ts' } });
  });
});
