/**
 * A narrow channel from a tool back to the harness that is running it.
 *
 * Only Plan Mode needs this so far: `exit_plan_mode` has to present its plan,
 * wait for a human yes/no, and — on yes — leave plan mode. What "leave plan
 * mode" means (which mode comes next, how the prompt is drawn) is a CLI policy
 * decision, so it lives behind this interface rather than in the tool.
 */

import type { PermissionMode } from '../permissions/types.js';

export interface AgentControl {
  /** The permission mode in effect right now. */
  readonly mode: PermissionMode;
  /**
   * Approve leaving plan mode. Returns the mode now in effect (chosen by the
   * CLI, not the tool). Safe to call when already out of plan mode.
   */
  exitPlanMode(): PermissionMode;
  /**
   * Present something for human approval. Absent in non-interactive runs — a
   * tool that needs a decision then must end the run instead (see `ToolResult.endsRun`).
   */
  confirm?(req: { title: string; body: string }): Promise<{ approved: boolean; feedback?: string }>;
}
