/**
 * Pure TUI state + reducer. Zero Ink imports — this is the testable core of the
 * UI: given a sequence of actions, what does the screen show?
 *
 * The hot path (per-token streaming) does *not* dispatch one action per delta —
 * the `EventBuffer` mutates synchronously and a ~30fps flush dispatches a single
 * `FLUSH`. Everything else (notices, user turns, modals) is a normal dispatch.
 */

import type {
  ContextSnapshot,
  Notice,
  PermissionMode,
  ToolResult,
  Usage,
} from '@harness-code/core';

export interface ToolItem {
  id: string;
  name: string;
  input: unknown;
  running: boolean;
  result?: ToolResult;
}

export interface LiveSnapshot {
  thinking: string;
  text: string;
  tools: ToolItem[];
}

export type Entry =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'assistant'; id: number; thinking: string; text: string; tools: ToolItem[] }
  | { kind: 'notice'; id: number; notice: Notice };

export interface PendingAsk {
  toolName: string;
  input: unknown;
  reason: string;
}

export interface PendingPlan {
  title: string;
  body: string;
}

export type OverlayKind = 'help' | 'resume';

export interface TuiState {
  entries: Entry[];
  live: LiveSnapshot;
  usage?: Usage;
  context?: ContextSnapshot;
  mode: PermissionMode;
  modelRef: string;
  cwd: string;
  pendingAsk: PendingAsk | null;
  pendingPlan: PendingPlan | null;
  overlay: OverlayKind | null;
  expandedOutput: boolean;
}

export type TuiAction =
  | { type: 'FLUSH'; live: LiveSnapshot }
  | {
      /** Commit the in-flight agentic step to the transcript and clear live. */
      type: 'COMMIT_LIVE';
      live: LiveSnapshot;
    }
  | { type: 'TURN_END'; live: LiveSnapshot; usage?: Usage; context?: ContextSnapshot }
  | { type: 'NOTICE'; notice: Notice }
  | { type: 'USER'; text: string }
  | { type: 'SET_MODE'; mode: PermissionMode }
  | { type: 'PENDING_ASK'; ask: PendingAsk }
  | { type: 'RESOLVE_ASK' }
  | { type: 'PENDING_PLAN'; plan: PendingPlan }
  | { type: 'RESOLVE_PLAN' }
  | { type: 'OPEN_OVERLAY'; overlay: OverlayKind }
  | { type: 'CLOSE_OVERLAY' }
  | { type: 'TOGGLE_EXPAND' }
  | { type: 'NEW_SESSION' };

export function emptyLive(): LiveSnapshot {
  return { thinking: '', text: '', tools: [] };
}

export function initialTuiState(opts: {
  mode: PermissionMode;
  modelRef: string;
  cwd: string;
}): TuiState {
  return {
    entries: [],
    live: emptyLive(),
    mode: opts.mode,
    modelRef: opts.modelRef,
    cwd: opts.cwd,
    pendingAsk: null,
    pendingPlan: null,
    overlay: null,
    expandedOutput: false,
  };
}

export function sessionReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case 'FLUSH':
      return { ...state, live: action.live };
    case 'COMMIT_LIVE': {
      const entries = commitLive(state.entries, action.live);
      return { ...state, entries, live: emptyLive() };
    }
    case 'TURN_END': {
      const entries = commitLive(state.entries, action.live);
      return {
        ...state,
        entries,
        live: emptyLive(),
        ...(action.usage ? { usage: action.usage } : {}),
        ...(action.context ? { context: action.context } : {}),
      };
    }
    case 'NOTICE':
      return {
        ...state,
        entries: [...state.entries, { kind: 'notice', id: state.entries.length, notice: action.notice }],
      };
    case 'USER':
      return {
        ...state,
        entries: [...state.entries, { kind: 'user', id: state.entries.length, text: action.text }],
      };
    case 'SET_MODE':
      return { ...state, mode: action.mode };
    case 'PENDING_ASK':
      return { ...state, pendingAsk: action.ask };
    case 'RESOLVE_ASK':
      return { ...state, pendingAsk: null };
    case 'PENDING_PLAN':
      return { ...state, pendingPlan: action.plan };
    case 'RESOLVE_PLAN':
      return { ...state, pendingPlan: null };
    case 'OPEN_OVERLAY':
      return { ...state, overlay: action.overlay };
    case 'CLOSE_OVERLAY':
      return { ...state, overlay: null };
    case 'TOGGLE_EXPAND':
      return { ...state, expandedOutput: !state.expandedOutput };
    case 'NEW_SESSION':
      return initialTuiState({ mode: state.mode, modelRef: state.modelRef, cwd: state.cwd });
  }
}

function commitLive(entries: Entry[], live: LiveSnapshot): Entry[] {
  if (live.thinking === '' && live.text === '' && live.tools.length === 0) return entries;
  return [
    ...entries,
    {
      kind: 'assistant',
      id: entries.length,
      thinking: live.thinking,
      text: live.text,
      tools: live.tools,
    },
  ];
}
