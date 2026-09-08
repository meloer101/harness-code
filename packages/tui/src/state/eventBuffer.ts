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

  onEvent(e: AgentEvent): void {
    switch (e.type) {
      case 'thinking_delta':
        this.live.thinking += e.text;
        break;
      case 'text_delta':
        this.live.text += e.text;
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

  reset(): void {
    this.live = emptyLive();
    this.byId.clear();
  }
}
