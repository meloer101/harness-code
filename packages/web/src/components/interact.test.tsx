import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import { Composer } from './Composer';
import { PendingDock } from './PendingDock';
import { allCommands } from '@/lib/slash';
import type { SessionViewState } from '@/lib/sessionModel';
import { useAppStore } from '@/lib/store';
import type { SessionSync } from '@/lib/sync';
import { SyncProvider } from '@/lib/syncContext';

afterEach(() => {
  cleanup();
  window.location.hash = '';
  useAppStore.setState({ status: 'closed', info: null, sessions: [], views: {}, slash: {}, error: null, helpOpen: false });
});

function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn(async () => true);
  const onAbort = vi.fn();
  render(
    <Composer
      sessionId="s1"
      running={false}
      disabled={false}
      commands={allCommands([{ command: 'review', server: 'gh', name: 'review' }])}
      onSend={onSend}
      onAbort={onAbort}
      {...overrides}
    />,
  );
  return { textarea: screen.getByRole('textbox') as HTMLTextAreaElement, onSend, onAbort };
}

describe('Composer', () => {
  it('sends on Enter and keeps Shift+Enter as a newline', () => {
    const { textarea, onSend } = renderComposer();
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('does not send on the Enter that confirms an IME candidate', () => {
    const { textarea, onSend } = renderComposer();
    fireEvent.change(textarea, { target: { value: '你好' } });
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('opens the / menu, filters it, and completes with Enter', () => {
    const { textarea, onSend } = renderComposer();
    fireEvent.change(textarea, { target: { value: '/' } });
    expect(screen.getByText('/help')).toBeTruthy();
    expect(screen.getByText('/review')).toBeTruthy();

    fireEvent.change(textarea, { target: { value: '/comp' } });
    expect(screen.queryByText('/help')).toBeNull();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled(); // completed, not sent
    expect(textarea.value).toBe('/compact ');
  });

  it('Escape closes the menu without reaching the window (which would abort)', () => {
    const onWindowEsc = vi.fn();
    window.addEventListener('keydown', onWindowEsc);
    const { textarea } = renderComposer();
    fireEvent.change(textarea, { target: { value: '/' } });
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(screen.queryByText('/help')).toBeNull();
    expect(onWindowEsc).not.toHaveBeenCalled();
    window.removeEventListener('keydown', onWindowEsc);
  });

  it('swaps send for stop while running', () => {
    const { onAbort } = renderComposer({ running: true });
    fireEvent.click(screen.getByLabelText('Stop'));
    expect(onAbort).toHaveBeenCalled();
  });
});

function dockView(over: Partial<SessionViewState> = {}): SessionViewState {
  return {
    id: 's1',
    modelRef: 'm',
    mode: 'ask',
    entries: [],
    live: { thinking: '', text: '', tools: [] },
    pendingAsk: { toolName: 'bash', input: { command: 'rm -rf /' }, reason: 'bash needs approval' },
    pendingPlan: null,
    running: true,
    hydrating: false,
    askId: 'a1',
    planId: null,
    ...over,
  };
}

function renderDock(view: SessionViewState) {
  const sync = { answerAsk: vi.fn(async () => {}), answerPlan: vi.fn(async () => {}) };
  const { container } = render(
    <SyncProvider sync={sync as unknown as SessionSync}>
      <PendingDock view={view} />
    </SyncProvider>,
  );
  const dock = container.querySelector('div[tabindex]')!;
  return { ...sync, dock };
}

describe('PendingDock', () => {
  it('answers with y / a / n like the TUI', () => {
    const sync = renderDock(dockView());
    const { dock } = sync;
    fireEvent.keyDown(dock, { key: 'y' });
    expect(sync.answerAsk).toHaveBeenCalledWith('s1', 'a1', 'once');
    fireEvent.keyDown(dock, { key: 'a' });
    expect(sync.answerAsk).toHaveBeenCalledWith('s1', 'a1', 'always');
    fireEvent.keyDown(dock, { key: 'n' });
    expect(sync.answerAsk).toHaveBeenCalledWith('s1', 'a1', 'deny', '');
    fireEvent.keyDown(dock, { key: 'Escape' });
    expect(sync.answerAsk).toHaveBeenCalledTimes(4);
  });

  it('passes typed feedback along with a deny', () => {
    const sync = renderDock(dockView());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'too risky' } });
    fireEvent.click(screen.getByText(/Deny/));
    expect(sync.answerAsk).toHaveBeenCalledWith('s1', 'a1', 'deny', 'too risky');
  });

  it('ignores shortcut keys typed into the feedback box', () => {
    const sync = renderDock(dockView());
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'y' });
    expect(sync.answerAsk).not.toHaveBeenCalled();
  });

  it('approves and rejects a plan with feedback', () => {
    const sync = renderDock(
      dockView({
        pendingAsk: null,
        askId: null,
        pendingPlan: { title: 'Plan', body: '1. do it' },
        planId: 'p1',
      }),
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'smaller steps' } });
    fireEvent.click(screen.getByText(/Reject/));
    expect(sync.answerPlan).toHaveBeenCalledWith('s1', 'p1', false, 'smaller steps');
    fireEvent.click(screen.getByText(/Approve/));
    expect(sync.answerPlan).toHaveBeenCalledWith('s1', 'p1', true);
  });
});

describe('global shortcuts', () => {
  function renderApp(view: SessionViewState) {
    const sync = {
      open: vi.fn(async () => {}),
      create: vi.fn(async () => 'new-id'),
      abort: vi.fn(async () => {}),
      send: vi.fn(async () => true),
      setHelpOpen: vi.fn(),
      dismissError: vi.fn(),
    };
    window.location.hash = '#/s/s1';
    useAppStore.setState({ status: 'open', views: { s1: view } });
    render(
      <SyncProvider sync={sync as unknown as SessionSync}>
        <App />
      </SyncProvider>,
    );
    return sync;
  }

  it('Escape stops a running session', () => {
    const sync = renderApp(dockView({ pendingAsk: null, askId: null, running: true }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(sync.abort).toHaveBeenCalledWith('s1');
  });

  it('Escape does nothing when the session is idle', () => {
    const sync = renderApp(dockView({ pendingAsk: null, askId: null, running: false }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(sync.abort).not.toHaveBeenCalled();
  });

  it('Cmd/Ctrl+K starts a new session', () => {
    const sync = renderApp(dockView({ pendingAsk: null, askId: null, running: false }));
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(sync.create).toHaveBeenCalled();
  });
});
