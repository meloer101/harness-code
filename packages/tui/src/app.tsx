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
import { Box, Static, Text, useInput, useStdout } from 'ink';

import type { AgentSession, PermissionMode, ReasoningEffort } from '@harness-code/core';
import { AGENT_DIR, findProjectRoot, listSessionIds, loadTranscript } from '@harness-code/core';
import type { EventBuffer } from '@harness-code/protocol';
import { entriesFromTranscript } from '@harness-code/protocol';

import { HistoryEntry, MeterBar, ModeBar, ToolCard } from './components/display.js';
import { EffortPicker } from './components/EffortPicker.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { Input, type CommandInfo } from './components/Input.js';
import { Overlay, PermissionModal, PlanModal } from './components/modals.js';
import { Markdown } from './markdown/render.js';
import type { UiStore } from './state/bridges.js';
import { initialTuiState, sessionReducer } from './state/reducer.js';
import type { TuiAction } from './state/reducer.js';
import { useTheme } from './hooks/useTheme.js';

const FLUSH_MS = 33;
const BUILTIN_COMMANDS: CommandInfo[] = [
  { command: '/help', description: 'show keys and commands' },
  { command: '/mode', description: 'switch permission mode (ask / acceptEdits / plan)' },
  { command: '/plan', description: 'enter plan mode' },
  { command: '/effort', description: 'adjust reasoning effort (←/→ picker)' },
  { command: '/compact', description: 'summarize history to free up context' },
  { command: '/cost', description: 'show token usage and cost' },
  { command: '/resume', description: 'resume a previous session' },
  { command: '/skills', description: 'list installed skills (pick a number to load)' },
  { command: '/skill', description: 'load a skill by name: /skill <name>' },
  { command: '/clear', description: 'clear the transcript' },
  { command: '/quit', description: 'exit Marvis' },
];
/** Shift+Tab-style permission-mode cycle for `/mode` with no argument. */
const MODE_CYCLE: readonly PermissionMode[] = ['ask', 'acceptEdits', 'plan'];
const ALL_MODES: readonly PermissionMode[] = ['ask', 'plan', 'acceptEdits', 'readOnly', 'yolo'];

export interface AppProps {
  initialSession: AgentSession;
  /** Builds a fresh session (optionally resuming `resumeId`), reusing the seams. */
  createSession: (resumeId?: string) => Promise<AgentSession>;
  /** Shared holder kept in sync with the current session for non-React callers. */
  sessionRef: { current: AgentSession | undefined };
  buffer: EventBuffer;
  store: UiStore;
  modelRef: string;
  cwd: string;
  onExit: () => void;
}

export function App({
  initialSession,
  createSession,
  sessionRef,
  buffer,
  store,
  modelRef,
  cwd,
  onExit,
}: AppProps) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const [session, setSession] = useState(initialSession);
  const [state, dispatch] = useReducer(
    sessionReducer,
    initialTuiState({
      mode: initialSession.mode,
      modelRef,
      cwd,
      ...(initialSession.effort ? { effort: initialSession.effort } : {}),
    }),
  );

  // `working` is the reactive source for `Input`'s disabled state (turns AND
  // session-mutating slash commands like /compact). `busyRef` stays the
  // synchronous guard for re-entrancy and the abort-vs-quit key decision.
  const [working, setWorking] = useState(false);
  const [effortDraft, setEffortDraft] = useState<ReasoningEffort>('medium');
  const busyRef = useRef(false);
  const lastCtrlCRef = useRef(0);
  const lastAskRef = useRef<unknown>(null);
  const lastPlanRef = useRef<unknown>(null);

  // Keep the shared holder pointed at the live session so the store's
  // "always allow" seam targets the session `/resume` may have swapped in.
  useEffect(() => {
    sessionRef.current = session;
  }, [session, sessionRef]);

  const d = useCallback((a: TuiAction) => dispatch(a), []);
  const flushNow = useCallback(() => {
    d({ type: 'FLUSH', live: buffer.snapshot() });
  }, [buffer, d]);

  // Flush loop: pull from the mutable buffer/store into React state.
  useEffect(() => {
    const tick = (): void => {
      for (const n of store.drainNotices()) d({ type: 'NOTICE', notice: n });
      // Only flush when the buffer actually changed — otherwise an idle session
      // would repaint at the tick rate for nothing (`takeDirty` mirrors the web
      // frontend's `#liveDirty` gate).
      if (buffer.takeDirty()) flushNow();
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
      setWorking(true);
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
        setWorking(false);
      }
    },
    [session, buffer, store, d],
  );

  const skills = useMemo(() => session.listSkills(), [session]);
  const effortLevels = useMemo(() => session.effortLevels, [session]);

  // Force-load a skill: nudge the model to call the `skill` tool by name, so the
  // load goes through the normal path (active-skill state, allowed-tools narrowing).
  const loadSkill = useCallback(
    (name: string) => {
      d({ type: 'CLOSE_OVERLAY' });
      void runTurn(`Load the "${name}" skill and follow its instructions.`);
    },
    [d, runTurn],
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
          // Ink's <Static> output is permanent; wipe the screen + scrollback so
          // "cleared" isn't a lie (committed lines otherwise stay on screen).
          stdout?.write('\x1b[2J\x1b[3J\x1b[H');
          store.pushNotice({
            kind: 'session-start',
            level: 'info',
            text: 'transcript cleared (session history kept)',
          });
          return;
        case 'compact': {
          if (busyRef.current) return;
          busyRef.current = true;
          setWorking(true);
          try {
            const saved = await session.compactNow();
            store.pushNotice({
              kind: 'compaction',
              level: 'info',
              text: saved
                ? `compacted: ${saved.tokensBefore} → ${saved.tokensAfter} tokens`
                : 'nothing to compact yet',
            });
          } finally {
            busyRef.current = false;
            setWorking(false);
          }
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
        case 'skills':
          d({ type: 'OPEN_OVERLAY', overlay: 'skills' });
          return;
        case 'skill': {
          const name = text.slice(1).split(/\s+/)[1];
          if (!name) {
            d({ type: 'OPEN_OVERLAY', overlay: 'skills' });
            return;
          }
          if (!skills.some((s) => s.name === name)) {
            store.pushNotice({ kind: 'error', level: 'error', text: `unknown skill "${name}"` });
            return;
          }
          loadSkill(name);
          return;
        }
        case 'plan':
          session.setMode('plan');
          d({ type: 'SET_MODE', mode: 'plan' });
          return;
        case 'mode': {
          const arg = text.slice(1).split(/\s+/)[1] as PermissionMode | undefined;
          const next: PermissionMode =
            arg && ALL_MODES.includes(arg)
              ? arg
              : (MODE_CYCLE[(MODE_CYCLE.indexOf(state.mode) + 1) % MODE_CYCLE.length] ?? 'ask');
          session.setMode(next);
          d({ type: 'SET_MODE', mode: next });
          return;
        }
        case 'effort': {
          const current = session.effort;
          if (current === undefined) {
            store.pushNotice({
              kind: 'session-start',
              level: 'info',
              text: 'this model has no reasoning effort',
            });
            return;
          }
          const arg = text.slice(1).split(/\s+/)[1] as ReasoningEffort | undefined;
          if (arg && effortLevels.includes(arg)) {
            // `/effort high` sets directly; bare `/effort` opens the picker.
            session.setEffort(arg);
            d({ type: 'SET_EFFORT', effort: arg });
            return;
          }
          setEffortDraft(current);
          d({ type: 'OPEN_OVERLAY', overlay: 'effort' });
          return;
        }
        default: {
          const expanded = await session.expandSlash(text);
          if (expanded !== null) await runTurn(expanded);
          else store.pushNotice({ kind: 'error', level: 'error', text: `unknown command "/${cmd}"` });
          return;
        }
      }
    },
    [session, store, d, runTurn, onExit, stdout, state.mode, skills, loadSkill, effortLevels],
  );

  const submit = useCallback(
    (text: string) => {
      void (text.startsWith('/') ? slash(text) : runTurn(text));
    },
    [slash, runTurn],
  );

  const commands = useMemo<CommandInfo[]>(() => {
    const mcp: CommandInfo[] = session
      .listSlashCommands()
      .map((c) => ({ command: `/${c.command}`, description: `MCP · ${c.server}` }));
    return [...BUILTIN_COMMANDS, ...mcp];
  }, [session]);

  const [sessions, setSessions] = useState<{ id: string; mtimeMs: number }[]>([]);

  // Resume a session in-process: build the replacement first (a bad id then
  // leaves the current session intact), swap it in, and rebuild the transcript
  // from its persisted history via the shared `entriesFromTranscript`.
  const resume = useCallback(
    async (id: string) => {
      if (busyRef.current) return;
      try {
        const next = await createSession(id);
        await session.close();
        buffer.reset();
        setSession(next);
        const agentDir = `${await findProjectRoot(cwd)}/${AGENT_DIR}`;
        const items = await loadTranscript(agentDir, id).catch(() =>
          next.messages.map((message) => ({ type: 'message' as const, ts: 0, message })),
        );
        d({
          type: 'HYDRATE',
          entries: entriesFromTranscript(items),
          mode: next.mode,
          ...(next.effort ? { effort: next.effort } : {}),
          ...(next.sessionUsage ? { usage: next.sessionUsage } : {}),
          ...(next.contextSnapshot ? { context: next.contextSnapshot } : {}),
        });
        d({ type: 'CLOSE_OVERLAY' });
      } catch (err) {
        store.pushNotice({
          kind: 'error',
          level: 'error',
          text: `resume failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
    [session, createSession, buffer, cwd, store, d],
  );

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
      if (key.escape) {
        d({ type: 'CLOSE_OVERLAY' });
        return;
      }
      if (state.overlay === 'resume' && /^[1-9]$/.test(input)) {
        const pick = sessions[Number(input) - 1];
        if (pick) void resume(pick.id);
      }
      if (state.overlay === 'skills' && /^[1-9]$/.test(input)) {
        const pick = skills[Number(input) - 1];
        if (pick) loadSkill(pick.name);
      }
      if (state.overlay === 'effort') {
        const i = effortLevels.indexOf(effortDraft);
        if (key.leftArrow) setEffortDraft(effortLevels[Math.max(0, i - 1)]!);
        else if (key.rightArrow)
          setEffortDraft(effortLevels[Math.min(effortLevels.length - 1, i + 1)]!);
        else if (key.return) {
          session.setEffort(effortDraft);
          d({ type: 'SET_EFFORT', effort: effortDraft });
          d({ type: 'CLOSE_OVERLAY' });
        }
      }
      return;
    }
    if (key.tab && key.shift) {
      // Shift+Tab cycles the permission mode (Tab alone stays with completion).
      const next = MODE_CYCLE[(MODE_CYCLE.indexOf(state.mode) + 1) % MODE_CYCLE.length] ?? 'ask';
      session.setMode(next);
      d({ type: 'SET_MODE', mode: next });
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
      <ErrorBoundary theme={theme}>
        <Static items={state.entries}>
          {(entry) => (
            <HistoryEntry key={entry.id} entry={entry} theme={theme} expanded={state.expandedOutput} />
          )}
        </Static>

        {/* Live (in-flight) region — mirrors the committed assistant layout. */}
        {(state.live.thinking !== '' || state.live.text !== '' || state.live.tools.length > 0) && (
          <Box marginTop={1}>
            <Text color={theme.text}>● </Text>
            <Box flexDirection="column" flexGrow={1}>
              {state.live.thinking !== '' && (
                <Text color={theme.faint}>{state.live.thinking}</Text>
              )}
              {state.live.text !== '' && <Markdown text={state.live.text} theme={theme} />}
              {state.live.tools.map((t) => (
                <ToolCard key={t.id} tool={t} expanded={state.expandedOutput} theme={theme} />
              ))}
            </Box>
          </Box>
        )}
      </ErrorBoundary>

      {state.pendingAsk && <PermissionModal ask={state.pendingAsk} theme={theme} />}
      {state.pendingPlan && <PlanModal plan={state.pendingPlan} theme={theme} />}
      {state.overlay === 'effort' ? (
        <EffortPicker value={effortDraft} levels={effortLevels} theme={theme} />
      ) : state.overlay ? (
        <Overlay
          kind={state.overlay}
          theme={theme}
          sessions={sessions}
          skills={skills}
          onPick={resume}
        />
      ) : null}

      <Input
        onSubmit={submit}
        commands={commands}
        theme={theme}
        disabled={working || state.pendingAsk !== null || state.pendingPlan !== null}
      />
      <ModeBar
        mode={state.mode}
        modelRef={state.modelRef}
        effort={state.effort}
        cwd={state.cwd}
        theme={theme}
      />
      <MeterBar usage={state.usage} context={state.context} theme={theme} />
    </>
  );
}
