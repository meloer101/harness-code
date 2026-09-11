/**
 * One session's client-side state, folded from the server's wire events with
 * the shared protocol logic (`EventBuffer` + `foldReducer`) so the web view and
 * the TUI agree on what a transcript looks like (docs/web.md, "Events").
 *
 * `SessionModel` is plain TS, no React: the sync layer feeds it events as they
 * arrive and pulls `state` once per animation frame. Deltas only touch the
 * mutable `EventBuffer`; the `live` snapshot is copied out lazily in `state`,
 * so a burst of 30 frames costs one allocation, not 30. Committed entries are
 * never recreated, so memoised rows keep their object identity.
 */

import type { AgentStopReason, ContextSnapshot, Notice, ToolResult, TranscriptItem } from '@harness-code/core';
import { EventBuffer, foldReducer, initialFoldState } from '@harness-code/protocol';
import type {
  Entry,
  FoldAction,
  FoldState,
  SessionSnapshot,
  ToolItem,
  WireEvent,
} from '@harness-code/protocol';

export interface SessionViewState extends FoldState {
  id: string;
  running: boolean;
  /** Ids of the pending requests, for `ask.answer` / `plan.answer`. */
  askId: string | null;
  planId: string | null;
}

const STOP_NOTICES: Partial<Record<AgentStopReason, string>> = {
  aborted: 'Interrupted.',
  max_turns: 'Stopped: turn limit reached.',
  max_cost: 'Stopped: cost budget reached.',
  max_tokens: 'Stopped: output token limit reached.',
  content_filter: 'Stopped by the provider content filter.',
  context_limit: 'Stopped: context window full.',
};

export class SessionModel {
  #buffer = new EventBuffer();
  #state: SessionViewState;
  #liveDirty = false;
  #lastSeq: number;

  constructor(snapshot: SessionSnapshot) {
    this.#state = stateFromSnapshot(snapshot);
    this.#lastSeq = snapshot.lastSeq;
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  /** Current view state; the live region is materialised here, at most once per change. */
  get state(): SessionViewState {
    if (this.#liveDirty) {
      this.#liveDirty = false;
      this.#dispatch({ type: 'FLUSH', live: this.#buffer.snapshot() });
    }
    return this.#state;
  }

  /** Replace everything with a server snapshot (first open, or a `reset` on resubscribe). */
  reset(snapshot: SessionSnapshot): void {
    this.#buffer.reset();
    this.#liveDirty = false;
    this.#state = stateFromSnapshot(snapshot);
    this.#lastSeq = snapshot.lastSeq;
  }

  /** Fold one event. Returns false when it was a duplicate (`seq <= lastSeq`) and was dropped. */
  apply(seq: number, event: WireEvent): boolean {
    if (seq <= this.#lastSeq) return false;
    this.#lastSeq = seq;

    switch (event.type) {
      case 'tool_call_start':
        // Opened mid-run: the assistant message (tool_use included) is
        // recorded before its permission ask, but `tool_call_start` only fires
        // once the ask is answered — so the card may already be in the
        // snapshot. Update it there rather than adding a second card.
        if (this.#patchCommittedTool(event.id, { running: true })) return true;
        this.#buffer.onEvent(event);
        this.#liveDirty = true;
        return true;
      case 'tool_call_end':
        if (!this.#buffer.snapshot().tools.some((t) => t.id === event.id)) {
          this.#patchCommittedTool(event.id, { running: false, result: event.result });
          return true;
        }
        this.#buffer.onEvent(event);
        this.#liveDirty = true;
        this.#commitCompletedBatch();
        return true;
      case 'text_delta':
      case 'thinking_delta':
      case 'turn_retry':
        this.#buffer.onEvent(event);
        this.#liveDirty = true;
        this.#commitCompletedBatch();
        return true;
      case 'context': {
        this.#buffer.onEvent(event);
        const context: ContextSnapshot = {
          usedTokens: event.usedTokens,
          windowTokens: event.windowTokens,
          ratio: event.ratio,
          breakdown: event.breakdown,
        };
        this.#state = { ...this.#state, context };
        return true;
      }
      case 'turn_end':
      case 'stop':
      case 'compaction':
        // `run_end` carries the session totals; compaction also arrives as a
        // `notice` (kind 'compaction'), which is what renders the divider.
        return true;
      case 'notice':
        this.#dispatch({ type: 'NOTICE', notice: event.notice });
        return true;
      case 'run_start':
        this.#buffer.reset();
        this.#liveDirty = false;
        this.#dispatch({ type: 'USER', text: event.input });
        this.#state = { ...this.#state, running: true };
        return true;
      case 'run_end': {
        this.#endRun();
        this.#dispatch({ type: 'TURN_END', live: this.#takeLive(), usage: event.sessionUsage });
        const stop = STOP_NOTICES[event.stopReason];
        if (stop) this.#dispatch({ type: 'NOTICE', notice: { kind: 'error', level: 'warn', text: stop } });
        return true;
      }
      case 'run_error':
        this.#endRun();
        this.#dispatch({ type: 'TURN_END', live: this.#takeLive() });
        this.#dispatch({ type: 'NOTICE', notice: { kind: 'error', level: 'error', text: event.message } });
        return true;
      case 'ask':
        this.#dispatch({
          type: 'PENDING_ASK',
          ask: { toolName: event.toolName, input: event.input, reason: event.reason },
        });
        this.#state = { ...this.#state, askId: event.askId };
        return true;
      case 'plan':
        this.#dispatch({ type: 'PENDING_PLAN', plan: { title: event.title, body: event.body } });
        this.#state = { ...this.#state, planId: event.planId };
        return true;
      case 'resolved':
        if (event.requestId === this.#state.askId) {
          this.#dispatch({ type: 'RESOLVE_ASK' });
          this.#state = { ...this.#state, askId: null };
        } else if (event.requestId === this.#state.planId) {
          this.#dispatch({ type: 'RESOLVE_PLAN' });
          this.#state = { ...this.#state, planId: null };
        }
        return true;
      case 'mode':
        this.#dispatch({ type: 'SET_MODE', mode: event.mode });
        return true;
    }
  }

  /** Update a tool card that is already committed; false if no entry has it. */
  #patchCommittedTool(id: string, patch: { running: boolean; result?: ToolResult }): boolean {
    const entries = this.#state.entries;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.kind !== 'assistant' || !e.tools.some((t) => t.id === id)) continue;
      const tools = e.tools.map((t) => (t.id === id ? { ...t, ...patch } : t));
      const next = [...entries];
      next[i] = { ...e, tools };
      this.#state = { ...this.#state, entries: next };
      return true;
    }
    return false;
  }

  #commitCompletedBatch(): void {
    const batch = this.#buffer.takeCompletedBatch();
    if (batch) {
      this.#liveDirty = false;
      this.#dispatch({ type: 'COMMIT_LIVE', live: batch });
    }
  }

  #takeLive() {
    const live = this.#buffer.snapshot();
    this.#buffer.reset();
    this.#liveDirty = false;
    return live;
  }

  #endRun(): void {
    // A finished run can't still be waiting on the user.
    this.#state = { ...this.#state, running: false, pendingAsk: null, pendingPlan: null, askId: null, planId: null };
  }

  #dispatch(action: FoldAction): void {
    const { id, running, askId, planId } = this.#state;
    this.#state = { ...foldReducer(this.#state, action), id, running, askId, planId };
  }
}

export function stateFromSnapshot(s: SessionSnapshot): SessionViewState {
  const base = initialFoldState({ mode: s.mode, modelRef: s.modelRef });
  return {
    ...base,
    entries: entriesFromTranscript(s.transcript),
    ...(s.usage ? { usage: s.usage } : {}),
    ...(s.context ? { context: s.context } : {}),
    pendingAsk: s.pendingAsk
      ? { toolName: s.pendingAsk.toolName, input: s.pendingAsk.input, reason: s.pendingAsk.reason }
      : null,
    pendingPlan: s.pendingPlan ? { title: s.pendingPlan.title, body: s.pendingPlan.body } : null,
    id: s.id,
    running: s.running,
    askId: s.pendingAsk?.askId ?? null,
    planId: s.pendingPlan?.planId ?? null,
  };
}

/**
 * Rebuild display entries from the persisted transcript: one `assistant` entry
 * per assistant message, tool results (which ride in the next `user` message)
 * attached back onto their tool cards, compactions as a divider notice.
 */
export function entriesFromTranscript(items: TranscriptItem[]): Entry[] {
  const entries: Entry[] = [];
  const tools = new Map<string, ToolItem>();

  for (const item of items) {
    if (item.type === 'compaction') {
      const notice: Notice = {
        kind: 'compaction',
        level: 'info',
        text: `Context compacted (${item.tokensBefore.toLocaleString()} → ${item.tokensAfter.toLocaleString()} tokens)`,
      };
      entries.push({ kind: 'notice', id: entries.length, notice });
      continue;
    }
    const { message } = item;
    if (message.role === 'assistant') {
      let thinking = '';
      let text = '';
      const entryTools: ToolItem[] = [];
      for (const block of message.content) {
        if (block.type === 'thinking') thinking += block.text;
        else if (block.type === 'text') text += block.text;
        else if (block.type === 'tool_use') {
          const tool: ToolItem = { id: block.id, name: block.name, input: block.input, running: false };
          entryTools.push(tool);
          tools.set(block.id, tool);
        }
      }
      if (thinking || text || entryTools.length) {
        entries.push({ kind: 'assistant', id: entries.length, thinking, text, tools: entryTools });
      }
      continue;
    }
    let userText = '';
    for (const block of message.content) {
      if (block.type === 'text') userText += block.text;
      else if (block.type === 'tool_result') {
        const tool = tools.get(block.toolUseId);
        if (tool) tool.result = { content: block.content, ...(block.isError ? { isError: true } : {}) };
      }
    }
    if (userText) entries.push({ kind: 'user', id: entries.length, text: userText });
  }
  return entries;
}
