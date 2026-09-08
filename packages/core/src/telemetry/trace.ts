/**
 * Per-session telemetry trace.
 *
 * A parallel channel to `SessionRecorder` (`agent/session.ts`): where that file
 * records *what was said* so `--resume` can replay it, this one records *what it
 * cost* — every model call's tokens / cache hits / latency / price, every tool
 * call's duration, every compaction, every sub-agent dispatch, and why each run
 * stopped. Append-per-event to `.agent/traces/<id>.jsonl`, same id as the
 * session, so a crash loses at most the in-flight turn.
 *
 * Kept separate from the session log on purpose: the trace carries volatile,
 * lossy data (input summaries, byte counts, wall-clock timing) that has no place
 * in the resume-critical path, and `hc trace` / `hc stats` read it without ever
 * touching `loadSession`. The full tool *output* is deliberately not stored here
 * — the session log already has it, and duplicating multi-megabyte grep dumps is
 * the exact hazard `docs/grep-output-blowup.md` describes; a byte count plus the
 * error flag is enough to render a timeline.
 */

import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ContextBreakdown } from '../context/budget.js';
import type { ToolResult } from '../tools/types.js';

export const TRACES_DIR = 'traces';

export function tracePath(agentDir: string, id: string): string {
  return join(agentDir, TRACES_DIR, `${id}.jsonl`);
}

/** How much of a tool call's stringified input we keep. Enough to tell two calls apart. */
const INPUT_SUMMARY_MAX = 200;

// ---------------------------------------------------------------------------
// Event schema
// ---------------------------------------------------------------------------

interface UsageFields {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export type TraceEvent =
  | {
      type: 'run_start';
      ts: number;
      sessionId: string;
      /** `provider/model` ref this run was launched with. */
      model: string;
      cwd: string;
      mode?: string;
      resumed?: boolean;
    }
  | ({
      type: 'model_call';
      ts: number;
      /** Turn number within this run (resets each `AgentLoop.run()`). */
      turn: number;
      model: string;
      reasoningTokens?: number;
      costUSD?: number;
      latencyMs?: number;
      ttftMs?: number;
      stopReason: string;
      /** True when the token counts are the harness's estimate, not endpoint-reported. */
      estimated?: boolean;
    } & UsageFields)
  | {
      type: 'tool_call';
      ts: number;
      turn: number;
      id: string;
      name: string;
      /** `JSON.stringify(input)`, capped. */
      inputSummary: string;
      durationMs: number;
      isError: boolean;
      /** The permission engine refused the call — it never ran. `isError` is also true. */
      denied?: boolean;
      /** Byte length of `result.content` — the output itself lives in the session log. */
      outputBytes: number;
      endsRun?: boolean;
    }
  | {
      type: 'compaction';
      ts: number;
      turn: number;
      tokensBefore: number;
      tokensAfter: number;
      keptTurns: number;
      costUSD?: number;
    }
  | {
      type: 'context';
      ts: number;
      turn: number;
      usedTokens: number;
      windowTokens: number;
      ratio: number;
      breakdown: ContextBreakdown;
    }
  | ({
      type: 'subagent';
      ts: number;
      turn: number;
      name: string;
      turns: number;
      costUSD?: number;
      stopReason: string;
    } & UsageFields)
  | {
      type: 'error';
      ts: number;
      turn: number;
      scope: 'provider' | 'tool';
      message: string;
    }
  | ({
      type: 'run_end';
      ts: number;
      stopReason: string;
      turns: number;
      costUSD?: number;
      wallMs: number;
    } & UsageFields);

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens?: number;
  costUSD?: number;
  estimated?: boolean;
}

/** Appends trace events as they happen. One instance per session. */
export class TraceRecorder {
  readonly id: string;
  private readonly path: string;

  constructor(agentDir: string, id: string) {
    this.id = id;
    this.path = tracePath(agentDir, id);
  }

  /** Write one already-shaped event. */
  async append(event: TraceEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, 'utf8');
  }

  // --- TraceSink: called by AgentLoop at the same sites as SessionRecorder ---

  async modelCall(r: {
    turn: number;
    model: string;
    usage: Usage;
    costUSD?: number;
    latencyMs?: number;
    ttftMs?: number;
    stopReason: string;
  }): Promise<void> {
    await this.append({
      type: 'model_call',
      ts: Date.now(),
      turn: r.turn,
      model: r.model,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
      cachedInputTokens: r.usage.cachedInputTokens,
      ...(r.usage.reasoningTokens ? { reasoningTokens: r.usage.reasoningTokens } : {}),
      ...(r.costUSD !== undefined ? { costUSD: r.costUSD } : {}),
      ...(r.latencyMs !== undefined ? { latencyMs: r.latencyMs } : {}),
      ...(r.ttftMs !== undefined ? { ttftMs: r.ttftMs } : {}),
      stopReason: r.stopReason,
      ...(r.usage.estimated ? { estimated: true } : {}),
    });
  }

  async toolCall(r: {
    turn: number;
    id: string;
    name: string;
    input: unknown;
    durationMs: number;
    result: ToolResult;
    denied?: boolean;
  }): Promise<void> {
    await this.append({
      type: 'tool_call',
      ts: Date.now(),
      turn: r.turn,
      id: r.id,
      name: r.name,
      inputSummary: summarizeInput(r.input),
      durationMs: Math.round(r.durationMs),
      isError: r.result.isError === true,
      ...(r.denied ? { denied: true } : {}),
      outputBytes: Buffer.byteLength(r.result.content ?? '', 'utf8'),
      ...(r.result.endsRun ? { endsRun: true } : {}),
    });
  }

  async compaction(r: {
    turn: number;
    tokensBefore: number;
    tokensAfter: number;
    keptTurns: number;
    costUSD?: number;
  }): Promise<void> {
    await this.append({
      type: 'compaction',
      ts: Date.now(),
      turn: r.turn,
      tokensBefore: r.tokensBefore,
      tokensAfter: r.tokensAfter,
      keptTurns: r.keptTurns,
      ...(r.costUSD !== undefined ? { costUSD: r.costUSD } : {}),
    });
  }

  async context(r: {
    turn: number;
    usedTokens: number;
    windowTokens: number;
    ratio: number;
    breakdown: ContextBreakdown;
  }): Promise<void> {
    await this.append({
      type: 'context',
      ts: Date.now(),
      turn: r.turn,
      usedTokens: r.usedTokens,
      windowTokens: r.windowTokens,
      ratio: r.ratio,
      breakdown: r.breakdown,
    });
  }

  async error(r: { turn: number; scope: 'provider' | 'tool'; message: string }): Promise<void> {
    await this.append({
      type: 'error',
      ts: Date.now(),
      turn: r.turn,
      scope: r.scope,
      message: r.message,
    });
  }
}

function summarizeInput(input: unknown): string {
  let s: string;
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  if (s === undefined) return '';
  return s.length > INPUT_SUMMARY_MAX ? `${s.slice(0, INPUT_SUMMARY_MAX)}…` : s;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Parse a trace file into events. Tolerates a torn final line (a crash mid-write)
 * by skipping any line that does not parse — the rest of the trace is still good.
 */
export async function readTrace(agentDir: string, id: string): Promise<TraceEvent[]> {
  const raw = await readFile(tracePath(agentDir, id), 'utf8');
  const events: TraceEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch {
      // Torn line from an interrupted append — ignore and keep the rest.
    }
  }
  return events;
}

/** Every trace id under `.agent/traces`, with its file mtime, newest first. */
export async function listTraceIds(
  agentDir: string,
): Promise<{ id: string; mtimeMs: number }[]> {
  let names: string[];
  try {
    names = await readdir(join(agentDir, TRACES_DIR));
  } catch {
    return []; // No traces dir yet.
  }
  const out: { id: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    try {
      const s = await stat(tracePath(agentDir, id));
      out.push({ id, mtimeMs: s.mtimeMs });
    } catch {
      // Vanished between readdir and stat — skip.
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
