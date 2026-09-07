/**
 * The tool contract.
 *
 * A `ToolSpec` is the one place a tool declares both what it needs (a zod
 * schema, so validation and the JSON Schema sent to the model come from the
 * same source of truth) and how the loop is allowed to run it
 * (`readOnly`/`concurrencySafe`). Phase 3's permission engine and this
 * phase's scheduler both read those two flags — a tool never declares its
 * own permission level, since that is a per-installation policy decision,
 * not a property of the tool.
 */

import { z } from 'zod';

import type { JSONSchema, ToolDefinition } from '../provider/types.js';
import type { AgentControl } from '../agent/control.js';
import type { SessionState } from '../agent/session.js';

export interface ToolContext {
  /** Workspace root tool paths are resolved against. */
  cwd: string;
  signal?: AbortSignal;
  session: SessionState;
  /** Channel back to the harness. Present only when the loop was given one. */
  control?: AgentControl;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Set by a tool that is a deliberate end of the run (e.g. `exit_plan_mode` with no interactive approver). */
  endsRun?: boolean;
}

export interface ToolSpec<TInput = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<TInput>;
  /**
   * The JSON Schema sent to the model, when it should not be derived from
   * `schema`. MCP tools set this: their contract is a raw JSON Schema the
   * server owns, and `schema` is only a passthrough guard (real validation
   * happens server-side). Builtin tools leave it unset and the definition is
   * generated from `schema`.
   */
  rawInputSchema?: JSONSchema;
  /** Never mutates the workspace. */
  readOnly: boolean;
  /**
   * Safe to run concurrently with other concurrency-safe tool calls in the same
   * turn. Read-only tools are the common case, but `task` is also safe (each
   * sub-agent is isolated) while not being read-only. A write tool that would
   * race another declares `false`.
   */
  concurrencySafe: boolean;
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}

/** Type-erased view used by the registry and loop, which do not know `TInput`. */
export type AnyToolSpec = ToolSpec<unknown>;

export function toolDefinition(spec: AnyToolSpec): ToolDefinition {
  const schema = spec.rawInputSchema
    ? ({ ...spec.rawInputSchema } as JSONSchema)
    : (z.toJSONSchema(spec.schema) as JSONSchema);
  delete schema.$schema;
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: schema,
  };
}
