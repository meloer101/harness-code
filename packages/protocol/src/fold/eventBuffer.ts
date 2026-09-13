/**
 * The push→pull event bridge's mutable half.
 *
 * `AgentSession.onEvent` fires synchronously, once per token. Frontends never
 * dispatch UI state directly on that path (tearing / flicker); instead this
 * object mutates cheaply and a ~30fps flush loop copies `snapshot()` into the
 * fold reducer. Important events also request an immediate flush from the
 * frontend so the last token is never dropped — see docs/web.md, "Delta
 * coalescing".
 */

import type { AgentEvent } from '@harness-code/core';

import type { LiveSnapshot, ToolItem } from './reducer.js';
import { emptyLive } from './reducer.js';

export class EventBuffer {
  private live: LiveSnapshot = emptyLive();
  private readonly byId = new Map<string, ToolItem>();
  /** Set when a tool batch has fully completed since the last reset. */
  private batchBoundary = false;
  /** Lengths of `live.thinking` / `live.text` when the current model call began. */
  private turnMark = { thinking: 0, text: 0 };
  /**
   * Set whenever an event changed the live snapshot, cleared by `takeDirty()`.
   * Lets a poll-loop frontend skip the flush (and the re-render it triggers)
   * when nothing changed — see `takeDirty` and docs/web.md, "Delta coalescing".
   */
  private dirty = false;

  onEvent(e: AgentEvent): void {
    switch (e.type) {
      case 'thinking_delta':
        this.live.thinking += e.text;
        this.dirty = true;
        break;
      case 'text_delta':
        this.live.text += e.text;
        this.dirty = true;
        break;
      case 'context':
        // Emitted once at the start of every model call: remember where this
        // turn's output begins, so a retry can drop exactly this turn's deltas.
        // No visible change to the live snapshot, so it doesn't mark dirty.
        this.turnMark = { thinking: this.live.thinking.length, text: this.live.text.length };
        break;
      case 'turn_retry':
        // The failed attempt's deltas are void — the retry streams the turn
        // from scratch. It failed before any tool ran, so no tool items exist.
        this.live.thinking = this.live.thinking.slice(0, this.turnMark.thinking);
        this.live.text = this.live.text.slice(0, this.turnMark.text);
        this.dirty = true;
        break;
      case 'tool_call_start': {
        const tool: ToolItem = { id: e.id, name: e.name, input: e.input, running: true };
        this.live.tools.push(tool);
        this.byId.set(e.id, tool);
        this.dirty = true;
        break;
      }
      case 'tool_call_end': {
        const tool = this.byId.get(e.id);
        if (tool) {
          tool.running = false;
          tool.result = e.result;
          this.dirty = true;
          if (!this.hasRunningTool()) this.batchBoundary = true;
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * True (clearing the flag) if the live snapshot changed since the last call.
   * A poll-loop frontend uses this to flush only on change, so an idle session
   * stops re-rendering — the web frontend's `SessionModel` does the same with
   * its `#liveDirty` flag.
   */
  takeDirty(): boolean {
    const was = this.dirty;
    this.dirty = false;
    return was;
  }

  snapshot(): LiveSnapshot {
    return {
      thinking: this.live.thinking,
      text: this.live.text,
      tools: this.live.tools.map((t) => ({ ...t })),
    };
  }

  /** True while at least one tracked tool is still running. */
  hasRunningTool(): boolean {
    for (const t of this.byId.values()) if (t.running) return true;
    return false;
  }

  /**
   * True once a tool batch (one or more tool calls that overlapped in flight)
   * has fully completed since the last reset. Prefer `takeCompletedBatch()`
   * for the commit itself; this is exposed mainly for tests and callers that
   * need to observe the boundary without consuming it.
   */
  hasBatchBoundary(): boolean {
    return this.batchBoundary;
  }

  /**
   * The batch-commit rule (originally `packages/tui/src/app.tsx` ~L67-70,
   * now shared so the server applies the same rule per docs/web.md's "Delta
   * coalescing"): once a full agentic step has completed, hand back its live
   * snapshot to commit to the transcript and reset for the next step.
   * Returns `null` while a tool is still running — the card would be frozen
   * mid-flight in the transcript — or no batch boundary has been reached yet.
   */
  takeCompletedBatch(): LiveSnapshot | null {
    if (!this.batchBoundary || this.hasRunningTool()) return null;
    const snap = this.snapshot();
    this.reset();
    return snap;
  }

  reset(): void {
    this.live = emptyLive();
    this.byId.clear();
    this.batchBoundary = false;
    this.turnMark = { thinking: 0, text: 0 };
    this.dirty = false;
  }
}
