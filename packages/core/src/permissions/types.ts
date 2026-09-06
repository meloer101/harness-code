import type { PermissionDecision } from '../agent/hooks.js';

export type PermissionMode = 'ask' | 'plan' | 'acceptEdits' | 'readOnly' | 'yolo';

export interface PermissionRule {
  /** Canonical lowercase tool name. */
  tool: string;
  /** Glob / bash pattern; omitted means the whole tool. */
  pattern?: string;
  raw: string;
}

export type PermissionVerdict =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'ask'; reason: string };

export type AskHandler = (req: {
  toolName: string;
  input: unknown;
  reason: string;
  /** Aborts when the turn is cancelled (Ctrl+C); the handler should settle as a deny. */
  signal?: AbortSignal;
}) => Promise<PermissionDecision>;

export interface PermissionConfig {
  mode?: PermissionMode;
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

export interface EvaluateRequest {
  toolName: string;
  input: unknown;
  readOnly: boolean;
}
