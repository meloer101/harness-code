import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { useAppStore } from './lib/store';
import { SessionSync } from './lib/sync';
import { SyncProvider } from './lib/syncContext';

function renderApp() {
  // Never started: no socket, so the view stays on whatever the store holds.
  const sync = new SessionSync({ url: 'ws://unused/ws', token: 't' });
  return render(
    <SyncProvider sync={sync}>
      <App />
    </SyncProvider>,
  );
}

afterEach(() => {
  cleanup();
  window.location.hash = '';
  useAppStore.setState({ status: 'closed', info: null, sessions: [], views: {}, error: null });
});

describe('App', () => {
  it('shows the empty state on the home route', () => {
    renderApp();
    expect(screen.getByText('No session selected')).toBeTruthy();
  });

  it('shows the reconnecting banner while the socket is down', () => {
    useAppStore.setState({ status: 'reconnecting' });
    renderApp();
    expect(screen.getByText(/reconnecting/)).toBeTruthy();
  });

  it('renders a session view from the store on a session route', () => {
    useAppStore.setState({
      status: 'open',
      views: {
        abc: {
          id: 'abc',
          modelRef: 'mock/mock-model',
          mode: 'ask',
          entries: [
            { kind: 'user', id: 0, text: 'hello there' },
            { kind: 'assistant', id: 1, thinking: '', text: 'General Kenobi', tools: [] },
          ],
          live: { thinking: '', text: '', tools: [] },
          pendingAsk: null,
          pendingPlan: null,
          running: false,
          askId: null,
          planId: null,
        },
      },
    });
    renderApp();
    act(() => {
      window.location.hash = '#/s/abc';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByText('hello there')).toBeTruthy();
    expect(screen.getByText('General Kenobi')).toBeTruthy();
    expect(screen.getByText('mock/mock-model')).toBeTruthy();
  });
});
