/**
 * The RPC method table: one entry per `ClientFrame.method`, each pairing a
 * zod schema (validates `params` — the server uses this exact schema) with a
 * result type (a phantom type-only marker; never assigned a runtime value).
 * `Call` derives a type-safe `call(method, params)` signature from the same
 * table, so client and server can never disagree about a method's shape.
 *
 * Method list, params, and results define the web frontend's RPC contract;
 * `SessionSummary` / `SessionSnapshot` carry `transcript: TranscriptItem[]`,
 * the full display history (distinct from the model's context window).
 */

import { z } from 'zod';

import type {
  ContextSnapshot,
  PermissionMode,
  SlashCommandInfo,
  TranscriptItem,
  Usage,
} from '@harness-code/core';

// ---------------------------------------------------------------------------
// Result-only interfaces
// ---------------------------------------------------------------------------

export interface ServerInfo {
  version: string;
  cwd: string;
  projectRoot: string;
  defaultModel: string;
  models: string[];
  modes: PermissionMode[];
}

/** One row of `session.list` — cheap enough to compute for every session on disk. */
export interface SessionSummary {
  id: string;
  mtimeMs: number;
  /** First user message, truncated. */
  title: string;
  /** Has a `SessionHost` in memory. */
  live: boolean;
  running: boolean;
  /** Waiting on an ask/plan — the sidebar badge. */
  pending: boolean;
}

export interface SessionSnapshot {
  id: string;
  modelRef: string;
  mode: PermissionMode;
  /** Full display history (distinct from the model's context window). */
  transcript: TranscriptItem[];
  usage?: Usage;
  context?: ContextSnapshot;
  running: boolean;
  pendingAsk?: { askId: string; toolName: string; input: unknown; reason: string };
  pendingPlan?: { planId: string; title: string; body: string };
  lastSeq: number;
}

export type SubscribeResult = { lastSeq: number } | { reset: true; snapshot: SessionSnapshot };

export type AskDecision = 'once' | 'always' | 'deny';

// ---------------------------------------------------------------------------
// Method table
// ---------------------------------------------------------------------------

/**
 * Tied to core's `PermissionMode` via `z.ZodType<PermissionMode>` so the
 * schema fails to typecheck the moment the two definitions drift, without
 * ever importing `PermissionMode` as a runtime value.
 */
const permissionModeSchema: z.ZodType<PermissionMode> = z.enum([
  'ask',
  'plan',
  'acceptEdits',
  'readOnly',
  'yolo',
]);

interface MethodSpec<P = unknown, R = unknown> {
  /** Validates `ClientFrame.params` for this method — same schema on client and server. */
  params: z.ZodType<P>;
  /** Phantom marker carrying the result type. Never assigned; read only via `MethodResult`. */
  result?: R;
}

function method<P, R>(params: z.ZodType<P>): MethodSpec<P, R> {
  return { params };
}

export const methods = {
  'server.info': method<void, ServerInfo>(z.void()),
  'session.list': method<void, SessionSummary[]>(z.void()),
  'session.create': method<{ model?: string; mode?: PermissionMode }, SessionSnapshot>(
    z.object({ model: z.string().optional(), mode: permissionModeSchema.optional() }),
  ),
  'session.open': method<{ id: string }, SessionSnapshot>(z.object({ id: z.string() })),
  /** Disk transcript only — no MCP / `AgentSession.create`. Used to render old sessions fast. */
  'session.preview': method<{ id: string }, SessionSnapshot>(z.object({ id: z.string() })),
  'session.subscribe': method<{ id: string; sinceSeq?: number }, SubscribeResult>(
    z.object({ id: z.string(), sinceSeq: z.number().optional() }),
  ),
  'session.unsubscribe': method<{ id: string }, void>(z.object({ id: z.string() })),
  'session.send': method<{ id: string; text: string }, { runId: string }>(
    z.object({ id: z.string(), text: z.string() }),
  ),
  'session.abort': method<{ id: string }, void>(z.object({ id: z.string() })),
  'session.setMode': method<{ id: string; mode: PermissionMode }, void>(
    z.object({ id: z.string(), mode: permissionModeSchema }),
  ),
  'session.compact': method<
    { id: string },
    { tokensBefore: number; tokensAfter: number } | null
  >(z.object({ id: z.string() })),
  'session.slashCommands': method<{ id: string }, SlashCommandInfo[]>(z.object({ id: z.string() })),
  'session.close': method<{ id: string }, void>(z.object({ id: z.string() })),
  'ask.answer': method<
    { sessionId: string; askId: string; decision: AskDecision; feedback?: string },
    void
  >(
    z.object({
      sessionId: z.string(),
      askId: z.string(),
      decision: z.enum(['once', 'always', 'deny']),
      feedback: z.string().optional(),
    }),
  ),
  'plan.answer': method<
    { sessionId: string; planId: string; approved: boolean; feedback?: string },
    void
  >(
    z.object({
      sessionId: z.string(),
      planId: z.string(),
      approved: z.boolean(),
      feedback: z.string().optional(),
    }),
  ),
} satisfies Record<string, MethodSpec>;

export type MethodName = keyof typeof methods;
export type MethodParams<M extends MethodName> = z.infer<(typeof methods)[M]['params']>;
export type MethodResult<M extends MethodName> = NonNullable<(typeof methods)[M]['result']>;

/**
 * A type-safe `call(method, params)` — `params` is required unless `M`'s
 * params type is `void`, so no-arg methods like `server.info` can be called
 * as `call('server.info')`.
 */
export interface Call {
  <M extends MethodName>(
    method: M,
    ...args: MethodParams<M> extends void ? [] : [params: MethodParams<M>]
  ): Promise<MethodResult<M>>;
}
