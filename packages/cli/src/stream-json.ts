/**
 * `--output-format stream-json`: item-centric JSONL on stdout.
 *
 * `turn_end` fires before same-turn tool calls finish, so `turn.completed` is
 * delayed until the next model stream starts (`text_delta` / `thinking_delta`)
 * or the run stops / finishes.
 */

import { summarizeInput } from '@harness-code/core';
import type { AgentEvent, AgentRunResult, ContextSnapshot, Notice, Usage } from '@harness-code/core';
import { isErrorStop } from './format.js';
import type { FailInfo, FinishInfo, OutputSink } from './output.js';
import { toResultJSON } from './output.js';
import { progressOfEvent, progressOfNotice, usageJSON } from './progress.js';

const TOOL_OUTPUT_MAX = 4_000;

type Phase = 'idle' | 'streaming' | 'tools';

interface TextItem {
  id: string;
  text: string;
}

interface ToolItem {
  id: string;
  tool: string;
}

interface PendingTurn {
  turn: number;
  usage?: Usage;
}

export class StreamJsonSink implements OutputSink {
  private turnNo = 0;
  private phase: Phase = 'idle';
  private agentMessageItem?: TextItem;
  private reasoningItem?: TextItem;
  private readonly toolItems = new Map<string, ToolItem>();
  private pendingTurn: PendingTurn | null = null;
  private finalText = '';
  private isError = false;
  private usage?: Usage;
  private context?: ContextSnapshot;
  private sessionId = '';

  constructor(private readonly modelRef: string) {}

  start(sessionId: string): void {
    this.sessionId = sessionId;
    this.write({
      type: 'thread.started',
      session_id: sessionId,
      model: this.modelRef,
    });
  }

  event(e: AgentEvent): void {
    switch (e.type) {
      case 'text_delta':
        this.beginModelStream();
        this.onAgentText(e.text);
        break;
      case 'thinking_delta':
        this.beginModelStream();
        this.onReasoningText(e.text);
        break;
      case 'turn_end':
        this.completeOpenTextItems();
        this.pendingTurn = { turn: this.turnNo, usage: e.usage };
        this.phase = 'tools';
        break;
      case 'tool_call_start':
        this.onToolStart(e.id, e.name, e.input);
        break;
      case 'tool_call_end':
        this.onToolEnd(e.id, e.name, e.result.content ?? '', e.result.isError === true);
        break;
      case 'turn_retry': {
        this.agentMessageItem = undefined;
        this.reasoningItem = undefined;
        const line = progressOfEvent(e);
        if (line) this.write(line);
        break;
      }
      case 'compaction': {
        const line = progressOfEvent(e);
        if (line) this.write(line);
        break;
      }
      case 'stop':
        this.flushPendingTurn();
        break;
      case 'context':
        break;
    }
  }

  notice(n: Notice): void {
    this.write(progressOfNotice(n));
  }

  turn(_modelRef: string, r: AgentRunResult, context?: ContextSnapshot): void {
    this.usage = r.usage;
    this.context = context;
  }

  finish(info: FinishInfo): void {
    this.flushPendingTurn();
    this.write(
      toResultJSON(
        info,
        this.finalText,
        this.usage ?? info.usage,
        this.context,
        this.isError || info.isError === true || isErrorStop(info.stopReason),
      ),
    );
  }

  fail(info: FailInfo): void {
    this.agentMessageItem = undefined;
    this.reasoningItem = undefined;
    this.flushPendingTurn();
    this.write({ type: 'error', ts: Date.now(), ...info.error });
    this.usage = info.usage;
    this.context = info.context;
    this.finish({
      sessionId: info.sessionId || this.sessionId,
      stopReason: 'error',
      turns: info.turns,
      isError: true,
      error: info.error,
    });
  }

  // ---------------------------------------------------------------------------

  private beginModelStream(): void {
    this.flushPendingTurn();
    if (this.phase === 'idle' || this.phase === 'tools') {
      this.turnNo += 1;
      this.phase = 'streaming';
      this.agentMessageItem = undefined;
      this.reasoningItem = undefined;
      this.write({ type: 'turn.started', turn: this.turnNo });
    }
  }

  private flushPendingTurn(): void {
    if (!this.pendingTurn) return;
    const { turn, usage } = this.pendingTurn;
    this.pendingTurn = null;
    this.write({
      type: 'turn.completed',
      turn,
      ...(usage ? { usage: usageJSON(usage) } : {}),
    });
  }

  private onAgentText(text: string): void {
    if (!this.agentMessageItem) {
      const id = `msg_${this.turnNo}`;
      this.agentMessageItem = { id, text: '' };
      this.write({
        type: 'item.started',
        item: { id, type: 'agent_message', turn: this.turnNo },
      });
    }
    this.agentMessageItem.text += text;
    this.write({
      type: 'item.updated',
      item: {
        id: this.agentMessageItem.id,
        type: 'agent_message',
        turn: this.turnNo,
        text: this.agentMessageItem.text,
      },
    });
  }

  private onReasoningText(text: string): void {
    if (!this.reasoningItem) {
      const id = `reasoning_${this.turnNo}`;
      this.reasoningItem = { id, text: '' };
      this.write({
        type: 'item.started',
        item: { id, type: 'reasoning', turn: this.turnNo },
      });
    }
    this.reasoningItem.text += text;
    this.write({
      type: 'item.updated',
      item: {
        id: this.reasoningItem.id,
        type: 'reasoning',
        turn: this.turnNo,
        text: this.reasoningItem.text,
      },
    });
  }

  private completeOpenTextItems(): void {
    if (this.agentMessageItem) {
      this.finalText += this.agentMessageItem.text;
      this.write({
        type: 'item.completed',
        item: {
          id: this.agentMessageItem.id,
          type: 'agent_message',
          turn: this.turnNo,
          text: this.agentMessageItem.text,
        },
      });
      this.agentMessageItem = undefined;
    }
    if (this.reasoningItem) {
      this.write({
        type: 'item.completed',
        item: {
          id: this.reasoningItem.id,
          type: 'reasoning',
          turn: this.turnNo,
          text: this.reasoningItem.text,
        },
      });
      this.reasoningItem = undefined;
    }
  }

  private onToolStart(id: string, tool: string, input: unknown): void {
    this.toolItems.set(id, { id, tool });
    this.write({
      type: 'item.started',
      item: {
        id,
        type: 'tool_call',
        turn: this.turnNo,
        tool,
        input: summarizeInput(input),
      },
    });
  }

  private onToolEnd(id: string, tool: string, output: string, isError: boolean): void {
    this.toolItems.delete(id);
    if (isError) this.isError = true;
    this.write({
      type: 'item.completed',
      item: {
        id,
        type: 'tool_call',
        turn: this.turnNo,
        tool,
        output: capText(output, TOOL_OUTPUT_MAX),
        is_error: isError,
      },
    });
  }

  private write(line: object): void {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }
}

function capText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
