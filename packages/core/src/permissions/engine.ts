import { inspectBash } from './bash-ast.js';
import { KNOWN_TOOLS, PLANS_DIR_PREFIX, READ_ONLY_TOOLS } from './defaults.js';
import { ruleMatchesBash, ruleMatchesPath } from './match.js';
import { parseRule } from './parse.js';
import { PathEscapeError, isSensitivePath, relativeToWorkspace, resolveInWorkspace } from './paths.js';
import type {
  EvaluateRequest,
  PermissionMode,
  PermissionRule,
  PermissionVerdict,
} from './types.js';

export interface PermissionEngineOptions {
  workspaceRoot: string;
  mode: PermissionMode;
  allow: string[];
  ask: string[];
  deny: string[];
}

export class PermissionEngine {
  private readonly workspaceRoot: string;
  private mode: PermissionMode;
  private readonly allow: PermissionRule[];
  private readonly askRules: PermissionRule[];
  private readonly deny: PermissionRule[];

  constructor(opts: PermissionEngineOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.mode = opts.mode;
    this.allow = opts.allow.map(parseRule);
    this.askRules = opts.ask.map(parseRule);
    this.deny = opts.deny.map(parseRule);
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  /** Switch the active mode. Used by Step 3's post-approval transition out of plan mode. */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /**
   * Append an allow rule at runtime — the "always allow, this session" path.
   * Whole-tool granularity only (`Bash`, not `Bash(npm test:*)`); reverse-engineering
   * a safe specifier prefix from one concrete call is error-prone, so this stays
   * coarse and the caller echoes exactly what was added.
   */
  addAllowRule(raw: string): void {
    this.allow.push(parseRule(raw));
  }

  async evaluate(req: EvaluateRequest): Promise<PermissionVerdict> {
    const tool = req.toolName.toLowerCase();
    if (!KNOWN_TOOLS.has(tool)) {
      return { decision: 'deny', reason: `Unknown tool "${req.toolName}"` };
    }

    if (tool === 'bash') {
      return this.evaluateBash(req.input);
    }

    if (tool === 'todo') {
      return this.evaluateTodo();
    }

    if (tool === 'exit_plan_mode') {
      return this.evaluateExitPlanMode();
    }

    return this.evaluatePathTool(tool, req);
  }

  /**
   * `exit_plan_mode` still honours an explicit deny rule, but is otherwise always
   * allowed — the real gate is the human approval the tool itself performs.
   */
  private evaluateExitPlanMode(): PermissionVerdict {
    const denied = this.deny.find((r) => r.tool === 'exit_plan_mode');
    if (denied) return { decision: 'deny', reason: `Blocked by deny rule ${denied.raw}` };
    return { decision: 'allow' };
  }

  private evaluateTodo(): PermissionVerdict {
    const denied = this.deny.find((r) => r.tool === 'todo');
    if (denied) return { decision: 'deny', reason: `Blocked by deny rule ${denied.raw}` };
    const allowed = this.allow.find((r) => r.tool === 'todo');
    if (allowed) return { decision: 'allow' };
    const asked = this.askRules.find((r) => r.tool === 'todo');
    if (asked) return { decision: 'ask', reason: `Requires approval (${asked.raw})` };
    return this.modeDefault('todo', true);
  }

  private async evaluateBash(input: unknown): Promise<PermissionVerdict> {
    const rec = asRecord(input);
    const command = typeof rec.command === 'string' ? rec.command : '';
    const inspected = inspectBash(command);
    if (inspected.hardDenyReason) {
      return { decision: 'deny', reason: inspected.hardDenyReason };
    }

    if (typeof rec.cwd === 'string') {
      try {
        await resolveInWorkspace(this.workspaceRoot, rec.cwd);
      } catch (err) {
        if (err instanceof PathEscapeError) {
          return { decision: 'deny', reason: err.message };
        }
        throw err;
      }
    }

    const segs = inspected.segments;
    for (const seg of segs) {
      const denied = this.deny.find((r) => ruleMatchesBash(r, seg));
      if (denied) {
        return { decision: 'deny', reason: `Blocked by deny rule ${denied.raw}` };
      }
    }

    if (segs.length > 0 && segs.every((seg) => this.allow.some((r) => ruleMatchesBash(r, seg)))) {
      return { decision: 'allow' };
    }

    for (const seg of segs) {
      const asked = this.askRules.find((r) => ruleMatchesBash(r, seg));
      if (asked) {
        return { decision: 'ask', reason: `Requires approval (${asked.raw})` };
      }
    }

    return this.modeDefault('bash', false);
  }

  private async evaluatePathTool(tool: string, req: EvaluateRequest): Promise<PermissionVerdict> {
    const target = pathFromInput(tool, req.input);

    let rel: string | undefined;
    if (target !== undefined) {
      try {
        rel = await relativeToWorkspace(this.workspaceRoot, target);
      } catch (err) {
        if (err instanceof PathEscapeError) {
          return { decision: 'deny', reason: err.message };
        }
        throw err;
      }
    }

    if (rel !== undefined) {
      const denied = this.deny.find((r) => ruleMatchesPath(r, tool, rel));
      if (denied) {
        return { decision: 'deny', reason: `Blocked by deny rule ${denied.raw}` };
      }

      if (isSensitivePath(rel)) {
        const specificAllow = this.allow.find(
          (r) => r.pattern !== undefined && ruleMatchesPath(r, tool, rel),
        );
        if (!specificAllow) {
          return { decision: 'deny', reason: `Refusing to access sensitive file ${rel}` };
        }
        return { decision: 'allow' };
      }

      const allowed = this.allow.find((r) => ruleMatchesPath(r, tool, rel));
      if (allowed) return { decision: 'allow' };

      const asked = this.askRules.find((r) => ruleMatchesPath(r, tool, rel));
      if (asked) {
        return { decision: 'ask', reason: `Requires approval (${asked.raw})` };
      }
    } else {
      const denied = this.deny.find((r) => r.tool === tool && r.pattern === undefined);
      if (denied) return { decision: 'deny', reason: `Blocked by deny rule ${denied.raw}` };
      const allowed = this.allow.find((r) => r.tool === tool && r.pattern === undefined);
      if (allowed) return { decision: 'allow' };
      const asked = this.askRules.find((r) => r.tool === tool && r.pattern === undefined);
      if (asked) return { decision: 'ask', reason: `Requires approval (${asked.raw})` };
    }

    return this.modeDefault(tool, req.readOnly || READ_ONLY_TOOLS.has(tool), rel);
  }

  private modeDefault(tool: string, readOnly: boolean, rel?: string): PermissionVerdict {
    switch (this.mode) {
      case 'yolo':
        return { decision: 'allow' };
      case 'readOnly':
        if (readOnly || tool === 'todo') return { decision: 'allow' };
        return {
          decision: 'deny',
          reason: `"${tool}" is not allowed in ${this.mode} mode`,
        };
      case 'plan':
        if (readOnly || tool === 'todo') return { decision: 'allow' };
        // The one write path plan mode leaves open: the plan file itself.
        // `rel` is relative to workspaceRoot (--cwd); when --cwd is a project
        // subdirectory, `.agent` sits outside the cage and this never matches —
        // but exit_plan_mode writes its file through fs directly, so the main
        // path is unaffected.
        if (
          (tool === 'write' || tool === 'edit') &&
          rel !== undefined &&
          rel.startsWith(PLANS_DIR_PREFIX)
        ) {
          return { decision: 'allow' };
        }
        return {
          decision: 'deny',
          reason: `"${tool}" is not allowed in ${this.mode} mode`,
        };
      case 'acceptEdits':
        if (tool === 'write' || tool === 'edit' || readOnly || tool === 'todo') {
          return { decision: 'allow' };
        }
        if (tool === 'bash') {
          return { decision: 'ask', reason: 'bash requires approval in acceptEdits mode' };
        }
        return { decision: 'ask', reason: `${tool} requires approval` };
      case 'ask':
      default:
        return { decision: 'ask', reason: `${tool} requires approval in ask mode` };
    }
  }
}

export function createPermissionEngine(opts: PermissionEngineOptions): PermissionEngine {
  return new PermissionEngine(opts);
}

function asRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object') return input as Record<string, unknown>;
  return {};
}

function pathFromInput(tool: string, input: unknown): string | undefined {
  const rec = asRecord(input);
  if (typeof rec.path === 'string') return rec.path;
  if (typeof rec.cwd === 'string') return rec.cwd;
  if (tool === 'glob' || tool === 'grep') return '.';
  return undefined;
}
