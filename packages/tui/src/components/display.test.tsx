import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';

import type { ToolResult } from '@harness-code/core';

import { MeterBar, ToolCard } from './display.js';
import { DARK } from '../theme.js';

afterEach(cleanup);

describe('MeterBar', () => {
  it('shows token counts and cost', () => {
    const { lastFrame } = render(
      <MeterBar
        usage={{ inputTokens: 1200, outputTokens: 300, cachedInputTokens: 1000, costUSD: 0.0042 }}
        context={undefined}
        theme={DARK}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('↑1.2k');
    expect(frame).toContain('↓300');
    expect(frame).toContain('$0.00420');
  });

  it('renders nothing without usage', () => {
    const { lastFrame } = render(<MeterBar usage={undefined} context={undefined} theme={DARK} />);
    expect(lastFrame() ?? '').toBe('');
  });
});

describe('ToolCard', () => {
  const result: ToolResult = { content: 'secret output' };
  const tool = { id: 'c1', name: 'bash', input: { command: 'ls' }, running: false, result };

  it('hides output when collapsed', () => {
    const { lastFrame } = render(<ToolCard tool={tool} expanded={false} theme={DARK} />);
    expect(lastFrame() ?? '').not.toContain('secret output');
  });

  it('shows output when expanded', () => {
    const { lastFrame } = render(<ToolCard tool={tool} expanded theme={DARK} />);
    expect(lastFrame() ?? '').toContain('secret output');
  });

  it('always shows an error result', () => {
    const { lastFrame } = render(
      <ToolCard
        tool={{ ...tool, result: { content: 'boom', isError: true } }}
        expanded={false}
        theme={DARK}
      />,
    );
    expect(lastFrame() ?? '').toContain('boom');
  });
});
