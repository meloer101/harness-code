import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';

import { Markdown } from './render.js';
import { DARK } from '../theme.js';

afterEach(cleanup);

describe('Markdown', () => {
  it('renders headings, bold, emphasis and inline code', () => {
    const { lastFrame } = render(
      <Markdown text={'# Title\n\nSome **bold** and *em* text with `code`.'} theme={DARK} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Title');
    expect(frame).toContain('bold');
    expect(frame).toContain('em');
    expect(frame).toContain('code');
  });

  it('renders list items with bullets', () => {
    const { lastFrame } = render(<Markdown text={'- one\n- two'} theme={DARK} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('• one');
    expect(frame).toContain('• two');
  });

  it('renders a code block as dim monospace lines', () => {
    const { lastFrame } = render(<Markdown text={'```\nline1\nline2\n```'} theme={DARK} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('line1');
    expect(frame).toContain('line2');
  });
});
