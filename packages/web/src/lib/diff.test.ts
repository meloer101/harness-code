import { describe, expect, it } from 'vitest';

import { editDiff, writeDiff } from './diff';

describe('editDiff', () => {
  it('marks changed lines and keeps shared ones as context', () => {
    const d = editDiff('a\nb\nc\n', 'a\nB\nc\n');
    expect(d.lines).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'ctx', text: 'c' },
    ]);
    expect([d.added, d.removed]).toEqual([1, 1]);
  });

  it('appending after an unterminated last line only adds lines', () => {
    const d = editDiff('4. last step', '4. last step\n\n- appended');
    expect(d.lines).toEqual([
      { kind: 'ctx', text: '4. last step' },
      { kind: 'add', text: '' },
      { kind: 'add', text: '- appended' },
    ]);
    expect([d.added, d.removed]).toEqual([2, 0]);
  });

  it('handles strings without trailing newlines', () => {
    const d = editDiff('first line', 'first line (edited)');
    expect(d.lines).toEqual([
      { kind: 'del', text: 'first line' },
      { kind: 'add', text: 'first line (edited)' },
    ]);
  });
});

describe('writeDiff', () => {
  it('shows every line as added', () => {
    expect(writeDiff('x\ny\n')).toEqual({
      lines: [
        { kind: 'add', text: 'x' },
        { kind: 'add', text: 'y' },
      ],
      added: 2,
      removed: 0,
    });
  });
});
