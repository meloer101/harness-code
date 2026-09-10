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

  onEvent(e: AgentEvent): void {
    switch (e.type) {
      case 'thinking_delta':
        this.live.thinking += e.text;
        break;
      case 'text_delta':
        this.live.text += e.text;
        break;
      case 'context':
        // Emitted once at the start of every model call: remember where this
        // turn's output begins, so a retry can drop exactly this turn's deltas.
        this.turnMark = { thinking: this.live.thinking.length, text: this.live.text.length };
        break;
      case 'turn_retry':
        // The failed attempt's deltas are void — the retry streams the turn
        // from scratch. It failed before any tool ran, so no tool items exist.
        this.live.thinking = this.live.thinking.slice(0, this.turnMark.thinking);
        this.live.text = this.live.text.slice(0, this.turnMark.text);
        break;
      case 'tool_call_start': {
        const tool: ToolItem = { id: e.id, name: e.name, input: e.input, running: true };
        this.live.tools.push(tool);
        this.byId.set(e.id, tool);
        break;
      }
      case 'tool_call_end': {
        const tool = this.byId.get(e.id);
        if (tool) {
          tool.running = false;
          tool.result = e.result;
          if (!this.hasRunningTool()) this.batchBoundary = true;
        }
        break;
      }
      default:
        break;
    }
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
  }
}
