/**
 * TUI-only state wrapper around the shared protocol fold
 * (`@harness-code/protocol`'s `FoldState`/`foldReducer`). `overlay`,
 * `expandedOutput`, and `cwd` are TUI-specific — everything else (the
 * transcript, live region, usage, context, mode, pending ask/plan) is folded
 * by the shared reducer so the TUI and the web frontend can never diverge on
 * how events turn into state. See docs/web.md, "Events".
 */

import type { PermissionMode, ReasoningEffort } from '@harness-code/core';
import type { FoldAction, FoldState } from '@harness-code/protocol';
import { emptyLive, foldReducer, initialFoldState } from '@harness-code/protocol';

export type { Entry, LiveSnapshot, PendingAsk, PendingPlan, ToolItem } from '@harness-code/protocol';
export { emptyLive };

export type OverlayKind = 'help' | 'resume' | 'skills' | 'effort';

export interface TuiState extends FoldState {
  cwd: string;
  overlay: OverlayKind | null;
  expandedOutput: boolean;
}

export type TuiAction =
  | FoldAction
  | { type: 'OPEN_OVERLAY'; overlay: OverlayKind }
  | { type: 'CLOSE_OVERLAY' }
  | { type: 'TOGGLE_EXPAND' };

export function initialTuiState(opts: {
  mode: PermissionMode;
  modelRef: string;
  cwd: string;
  effort?: ReasoningEffort;
}): TuiState {
  return {
    ...initialFoldState({
      mode: opts.mode,
      modelRef: opts.modelRef,
      ...(opts.effort ? { effort: opts.effort } : {}),
    }),
    cwd: opts.cwd,
    overlay: null,
    expandedOutput: false,
  };
}

export function sessionReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case 'OPEN_OVERLAY':
      return { ...state, overlay: action.overlay };
    case 'CLOSE_OVERLAY':
      return { ...state, overlay: null };
    case 'TOGGLE_EXPAND':
      return { ...state, expandedOutput: !state.expandedOutput };
    case 'NEW_SESSION':
      // The shared reducer only knows its own fields; starting a new session
      // in the TUI also closes any open overlay and collapses tool output.
      return { ...state, ...foldReducer(state, action), overlay: null, expandedOutput: false };
    default:
      return { ...state, ...foldReducer(state, action) };
  }
}
