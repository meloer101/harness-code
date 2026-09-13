/**
 * Shared (Ink/React-free) session fold: given a stream of coalesced agent
 * events, what does the transcript look like? Moved out of `packages/tui` so
 * the TUI and the web frontend fold events identically — see docs/web.md,
 * "Events": "Clients fold events with the same logic as EventBuffer."
 *
 * Frontend-only concerns are deliberately NOT here. `packages/tui/src/
 * state/reducer.ts` wraps `FoldState`/`foldReducer` with its own fields
 * (`overlay`, `expandedOutput`, `cwd`) and actions instead of forking this
 * logic; the web frontend will do the same.
 */

import type {
  ContextSnapshot,
  Notice,
  PermissionMode,
  ReasoningEffort,
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

export interface FoldState {
  entries: Entry[];
  live: LiveSnapshot;
  usage?: Usage;
  context?: ContextSnapshot;
  mode: PermissionMode;
  /** Reasoning-effort level; absent when the model has no reasoning channel. */
  effort?: ReasoningEffort;
  modelRef: string;
  pendingAsk: PendingAsk | null;
  pendingPlan: PendingPlan | null;
}

export type FoldAction =
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
  | { type: 'SET_EFFORT'; effort: ReasoningEffort }
  | { type: 'PENDING_ASK'; ask: PendingAsk }
  | { type: 'RESOLVE_ASK' }
  | { type: 'PENDING_PLAN'; plan: PendingPlan }
  | { type: 'RESOLVE_PLAN' }
  | { type: 'NEW_SESSION' }
  | {
      /**
       * Replace the whole transcript at once — used when a frontend switches to
       * a different (e.g. resumed) session and rebuilds `entries` from its
       * persisted history via `entriesFromTranscript`. Clears the live region
       * and any pending ask/plan; sets usage/context/mode when supplied.
       */
      type: 'HYDRATE';
      entries: Entry[];
      usage?: Usage;
      context?: ContextSnapshot;
      mode?: PermissionMode;
      effort?: ReasoningEffort;
    };

export function emptyLive(): LiveSnapshot {
  return { thinking: '', text: '', tools: [] };
}

export function initialFoldState(opts: {
  mode: PermissionMode;
  modelRef: string;
  effort?: ReasoningEffort;
}): FoldState {
  return {
    entries: [],
    live: emptyLive(),
    mode: opts.mode,
    modelRef: opts.modelRef,
    pendingAsk: null,
    pendingPlan: null,
    ...(opts.effort ? { effort: opts.effort } : {}),
  };
}

export function foldReducer(state: FoldState, action: FoldAction): FoldState {
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
    case 'SET_EFFORT':
      return { ...state, effort: action.effort };
    case 'PENDING_ASK':
      return { ...state, pendingAsk: action.ask };
    case 'RESOLVE_ASK':
      return { ...state, pendingAsk: null };
    case 'PENDING_PLAN':
      return { ...state, pendingPlan: action.plan };
    case 'RESOLVE_PLAN':
      return { ...state, pendingPlan: null };
    case 'NEW_SESSION':
      return initialFoldState({ mode: state.mode, modelRef: state.modelRef });
    case 'HYDRATE':
      return {
        ...state,
        entries: action.entries,
        live: emptyLive(),
        pendingAsk: null,
        pendingPlan: null,
        ...(action.usage ? { usage: action.usage } : {}),
        ...(action.context ? { context: action.context } : {}),
        ...(action.mode ? { mode: action.mode } : {}),
        ...(action.effort ? { effort: action.effort } : {}),
      };
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
