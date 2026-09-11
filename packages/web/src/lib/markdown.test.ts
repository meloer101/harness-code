import { describe, expect, it } from 'vitest';

import { closeOpenFences } from './markdown';

describe('closeOpenFences', () => {
  it('leaves balanced text alone', () => {
    const t = 'hi\n```ts\nconst a = 1;\n```\nbye';
    expect(closeOpenFences(t)).toBe(t);
    expect(closeOpenFences('no fences')).toBe('no fences');
  });

  it('closes a fence cut off mid-stream', () => {
    expect(closeOpenFences('see:\n```ts\nconst a')).toBe('see:\n```ts\nconst a\n```');
    expect(closeOpenFences('```\n')).toBe('```\n```');
  });

  it('matches the opening fence style and length', () => {
    expect(closeOpenFences('~~~\ncode')).toBe('~~~\ncode\n~~~');
    // A shorter fence inside a longer one does not close it.
    expect(closeOpenFences('````md\n```\ninner')).toBe('````md\n```\ninner\n````');
  });

  it('does not treat an info-string line as a closer', () => {
    expect(closeOpenFences('```\na\n```js')).toBe('```\na\n```js\n```');
  });
});
