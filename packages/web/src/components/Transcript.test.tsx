import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Transcript } from '@/components/Transcript';
import type { SessionViewState } from '@/lib/sessionModel';

function view(over: Partial<SessionViewState> = {}): SessionViewState {
  return {
    id: 's1',
    modelRef: 'm',
    mode: 'ask',
    entries: [],
    live: { thinking: '', text: '', tools: [] },
    pendingAsk: null,
    pendingPlan: null,
    running: false,
    hydrating: false,
    askId: null,
    planId: null,
    ...over,
  };
}

describe('Transcript compaction divider', () => {
  it('renders a horizontal rule and token summary for compaction notices', () => {
    const { container } = render(
      <Transcript
        view={view({
          entries: [
            {
              kind: 'notice',
              id: 0,
              notice: {
                kind: 'compaction',
                level: 'info',
                text: 'Context compacted (9,000 → 1,200 tokens)',
              },
            },
          ],
        })}
      />,
    );
    expect(screen.getByText('Context compacted (9,000 → 1,200 tokens)')).toBeTruthy();
    const rule = container.querySelector('.h-px.flex-1.bg-border');
    expect(rule).toBeTruthy();
  });
});
