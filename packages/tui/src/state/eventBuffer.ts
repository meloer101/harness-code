/**
 * The push→pull event bridge's mutable half.
 *
 * `AgentSession.onEvent` fires synchronously, once per token. We never dispatch
 * React state on that path (tearing / flicker); instead this object mutates
 * cheaply and the app's flush loop copies `snapshot()` into the reducer every
 * ~33ms. Important events (tool start/end, turn end) also request an immediate
 * flush from the app so the last token is never dropped.
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
   * has fully completed since the last reset. The app consumes this on its
   * flush loop: when set and no tool is running, the accumulated live content
   * is a complete agentic step and can be committed to the transcript.
   */
  hasBatchBoundary(): boolean {
    return this.batchBoundary;
  }

  reset(): void {
    this.live = emptyLive();
    this.byId.clear();
    this.batchBoundary = false;
    this.turnMark = { thinking: 0, text: 0 };
  }
}
