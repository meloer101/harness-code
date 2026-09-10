/**
 * The TUI root component: transcript + live region + bars + input + modals.
 *
 * Push→pull: `EventBuffer` mutates synchronously per token; a ~33ms flush loop
 * copies a snapshot into the reducer. Important events are flushed immediately
 * so the final token is never dropped. Key handling is centralized here —
 * modals are passive displays, and their `y`/`a`/`n`/`Esc` keys are routed back
 * through the `UiStore` resolvers.
 */

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Static, Text, useInput } from 'ink';

import type { AgentSession } from '@harness-code/core';
import { AGENT_DIR, findProjectRoot, listSessionIds } from '@harness-code/core';
import type { EventBuffer } from '@harness-code/protocol';

import { HistoryEntry, MeterBar, ModeBar, Rule, ToolCard } from './components/display.js';
import { Input } from './components/Input.js';
import { Overlay, PermissionModal, PlanModal } from './components/modals.js';
import { Markdown } from './markdown/render.js';
import type { UiStore } from './state/bridges.js';
import { initialTuiState, sessionReducer } from './state/reducer.js';
import type { TuiAction } from './state/reducer.js';
import { useTheme } from './hooks/useTheme.js';

const FLUSH_MS = 33;
const BUILTIN_COMMANDS = ['/help', '/clear', '/quit', '/compact', '/cost', '/resume', '/plan'];

export interface AppProps {
  session: AgentSession;
  buffer: EventBuffer;
  store: UiStore;
  modelRef: string;
  cwd: string;
  onExit: () => void;
}

export function App({ session, buffer, store, modelRef, cwd, onExit }: AppProps) {
  const theme = useTheme();
  const [state, dispatch] = useReducer(
    sessionReducer,
    initialTuiState({ mode: session.mode, modelRef, cwd }),
  );

  const busyRef = useRef(false);
  const lastCtrlCRef = useRef(0);
  const lastAskRef = useRef<unknown>(null);
  const lastPlanRef = useRef<unknown>(null);

  const d = useCallback((a: TuiAction) => dispatch(a), []);
  const flushNow = useCallback(() => {
    d({ type: 'FLUSH', live: buffer.snapshot() });
  }, [buffer, d]);

  // Flush loop: pull from the mutable buffer/store into React state.
  useEffect(() => {
    const tick = (): void => {
      for (const n of store.drainNotices()) d({ type: 'NOTICE', notice: n });
      flushNow();
      // A completed tool batch ends an agentic step: commit it to the
      // transcript and start a fresh live region. Without this, one long turn
      // (e.g. plan-mode approval then execution) would pin everything since the
      // last TURN_END at the top of the live region and squeeze the running
      // output into a sliver. `takeCompletedBatch` is the shared protocol rule
      // (never commits while a tool is still running — the card would be
      // frozen mid-flight in the transcript) so the server applies it
      // identically for the web frontend.
      const completedBatch = buffer.takeCompletedBatch();
      if (completedBatch) d({ type: 'COMMIT_LIVE', live: completedBatch });
      if (store.pendingAsk !== lastAskRef.current) {
        lastAskRef.current = store.pendingAsk;
        d(store.pendingAsk ? { type: 'PENDING_ASK', ask: store.pendingAsk } : { type: 'RESOLVE_ASK' });
      }
      if (store.pendingPlan !== lastPlanRef.current) {
        lastPlanRef.current = store.pendingPlan;
        d(
          store.pendingPlan
            ? { type: 'PENDING_PLAN', plan: store.pendingPlan }
            : { type: 'RESOLVE_PLAN' },
        );
      }
    };
    const id = setInterval(tick, FLUSH_MS);
    return () => clearInterval(id);
  }, [store, buffer, d, flushNow]);

  const runTurn = useCallback(
    async (text: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      d({ type: 'USER', text });
      try {
        await session.runTurn(text);
        d({
          type: 'TURN_END',
          live: buffer.snapshot(),
          usage: session.sessionUsage,
          context: session.contextSnapshot,
        });
        buffer.reset();
      } catch (err) {
        store.pushNotice({
          kind: 'error',
          level: 'error',
          text: `hc: ${err instanceof Error ? err.message : String(err)}`,
        });
        d({ type: 'TURN_END', live: buffer.snapshot() });
        buffer.reset();
      } finally {
        busyRef.current = false;
      }
    },
    [session, buffer, store, d],
  );

  const slash = useCallback(
    async (text: string) => {
      const [cmd] = text.slice(1).split(/\s+/);
      switch (cmd) {
        case 'help':
          d({ type: 'OPEN_OVERLAY', overlay: 'help' });
          return;
        case 'quit':
          onExit();
          return;
        case 'clear':
          d({ type: 'NEW_SESSION' });
          store.pushNotice({
            kind: 'session-start',
            level: 'info',
            text: 'transcript cleared (session history kept)',
          });
          return;
        case 'compact': {
          const saved = await session.compactNow();
          store.pushNotice({
            kind: 'compaction',
            level: 'info',
            text: saved
              ? `compacted: ${saved.tokensBefore} → ${saved.tokensAfter} tokens`
              : 'nothing to compact yet',
          });
          return;
        }
        case 'cost': {
          const u = session.sessionUsage;
          store.pushNotice({
            kind: 'session-start',
            level: 'info',
            text: u
              ? `usage: in ${u.inputTokens} · out ${u.outputTokens} · cached ${u.cachedInputTokens}` +
                (u.costUSD !== undefined ? ` · $${u.costUSD.toFixed(5)}` : '')
              : 'no usage recorded yet',
          });
          return;
        }
        case 'resume':
          d({ type: 'OPEN_OVERLAY', overlay: 'resume' });
          return;
        case 'plan':
          session.setMode('plan');
          d({ type: 'SET_MODE', mode: 'plan' });
          return;
        default: {
          const expanded = await session.expandSlash(text);
          if (expanded !== null) await runTurn(expanded);
          else store.pushNotice({ kind: 'error', level: 'error', text: `unknown command "/${cmd}"` });
          return;
        }
      }
    },
    [session, store, d, runTurn, onExit],
  );

  const submit = useCallback(
    (text: string) => {
      void (text.startsWith('/') ? slash(text) : runTurn(text));
    },
    [slash, runTurn],
  );

  const suggestions = useMemo(() => {
    const mcp = session.listSlashCommands().map((c) => `/${c.command}`);
    return [...BUILTIN_COMMANDS, ...mcp];
  }, [session]);

  const [sessions, setSessions] = useState<{ id: string; mtimeMs: number }[]>([]);

  useInput((input, key) => {
    if (store.pendingAsk) {
      if (input === 'y') store.answerAsk('once');
      else if (input === 'a') store.answerAsk('always');
      else if (input === 'n' || key.escape) store.answerAsk('deny');
      return;
    }
    if (store.pendingPlan) {
      if (input === 'y') store.answerPlan(true);
      else if (input === 'e') store.answerPlan(false, 'revise');
      else if (key.escape) store.answerPlan(false);
      return;
    }
    if (state.overlay) {
      if (key.escape) d({ type: 'CLOSE_OVERLAY' });
      return;
    }
    if (key.escape) {
      if (busyRef.current) session.abort();
      return;
    }
    if (key.ctrl && input === 'c') {
      if (busyRef.current) {
        session.abort();
      } else {
        const now = Date.now();
        if (now - lastCtrlCRef.current < 1500) onExit();
        else {
          lastCtrlCRef.current = now;
          store.pushNotice({ kind: 'session-start', level: 'info', text: 'press Ctrl+C again to exit' });
        }
      }
      return;
    }
    if (key.ctrl && input === 'd') {
      if (!busyRef.current) onExit();
      return;
    }
    if (key.ctrl && input === 'o') {
      d({ type: 'TOGGLE_EXPAND' });
      return;
    }
  });

  // Load the resume list lazily when the overlay opens.
  useEffect(() => {
    if (state.overlay !== 'resume') return;
    let cancelled = false;
    void (async () => {
      const root = await findProjectRoot(cwd);
      const list = await listSessionIds(`${root}/${AGENT_DIR}`);
      if (!cancelled) setSessions(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [state.overlay, cwd]);

  return (
    <>
      <Static items={state.entries}>
        {(entry) => (
          <HistoryEntry key={entry.id} entry={entry} theme={theme} expanded={state.expandedOutput} />
        )}
      </Static>

      {/* Live (in-flight) region */}
      {(state.live.thinking !== '' || state.live.text !== '' || state.live.tools.length > 0) && (
        <>
          {state.live.thinking !== '' && <Text color={theme.faint}>{state.live.thinking}</Text>}
          {state.live.text !== '' && <Markdown text={state.live.text} theme={theme} />}
          {state.live.tools.map((t) => (
            <ToolCard key={t.id} tool={t} expanded={state.expandedOutput} theme={theme} />
          ))}
        </>
      )}

      {state.pendingAsk && <PermissionModal ask={state.pendingAsk} theme={theme} />}
      {state.pendingPlan && <PlanModal plan={state.pendingPlan} theme={theme} />}
      {state.overlay && <Overlay kind={state.overlay} theme={theme} sessions={sessions} />}

      <Rule theme={theme} />
      <ModeBar mode={state.mode} modelRef={state.modelRef} cwd={state.cwd} theme={theme} />
      <MeterBar usage={state.usage} context={state.context} theme={theme} />
      <Input
        onSubmit={submit}
        suggestions={suggestions}
        theme={theme}
        disabled={busyRef.current || state.pendingAsk !== null || state.pendingPlan !== null}
      />
    </>
  );
}
