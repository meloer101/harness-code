/**
 * Terminal prompting for permission `ask` verdicts (and, in Step 3, plan
 * approval).
 *
 * Two problems this exists to solve:
 *
 *  - **Serialization.** `runToolCalls` collects every permission decision for a
 *    turn with `Promise.all`, so two tools needing approval in one turn would
 *    fire two `rl.question()` calls at once and race for the same line. Every
 *    prompt here is pushed onto one promise chain, the same fix the REPL uses
 *    for its input `queue`.
 *  - **readline ownership.** In REPL mode we borrow the outer `rl`: `rl.question()`
 *    intercepts exactly the next line without emitting `'line'`, so it doesn't
 *    fight the REPL's own handler. One-shot on a TTY has no outer `rl`, so the
 *    prompter makes its own and closes it when done.
 */

import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';

import type { AskHandler, PermissionEngine } from '@harness-code/core';

export type ConfirmChoice = 'once' | 'always' | 'deny';

export interface ConfirmRequest {
  title: string;
  detail: string;
  /** Shown after `[a]`, e.g. "Bash". Falls back to a generic phrase. */
  alwaysLabel?: string;
  signal?: AbortSignal;
}

export interface ConfirmResult {
  choice: ConfirmChoice;
  feedback?: string;
}

export interface ApproveRequest {
  title: string;
  body: string;
  signal?: AbortSignal;
}

export interface Prompter {
  confirm(req: ConfirmRequest): Promise<ConfirmResult>;
  /** Show a body of text (a plan) and collect approve / revise-with-feedback. */
  approve(req: ApproveRequest): Promise<{ approved: boolean; feedback?: string }>;
  askText(query: string, signal?: AbortSignal): Promise<string>;
  close(): void;
}

class ReadlinePrompter implements Prompter {
  private readonly rl: Interface;
  private readonly owned: boolean;
  /** Serializes every prompt so concurrent permission checks queue instead of racing. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(shared?: Interface) {
    if (shared) {
      this.rl = shared;
      this.owned = false;
    } else {
      this.rl = createInterface({ input: process.stdin, output: process.stdout });
      this.owned = true;
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** One line of input, resolving to '' if the signal fires first. */
  private question(query: string, signal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve) => {
      if (signal?.aborted) {
        resolve('');
        return;
      }
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        resolve('');
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.rl.question(query, (answer) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(answer);
      });
    });
  }

  confirm(req: ConfirmRequest): Promise<ConfirmResult> {
    return this.enqueue(async () => {
      if (req.signal?.aborted) return { choice: 'deny', feedback: '用户中断' };

      // The whole block goes through the query string so it lands on the
      // readline's own output stream, not unconditionally on process.stdout.
      const block = [
        `\n\x1b[1m? ${req.title}\x1b[0m`,
        ...req.detail.split('\n').map((l) => `    ${l}`),
        `  [y] allow once   [n] deny   [a] always allow ${req.alwaysLabel ?? 'this tool'} (this session)`,
        '> ',
      ].join('\n');

      const raw = (await this.question(block, req.signal)).trim().toLowerCase();
      if (req.signal?.aborted) return { choice: 'deny', feedback: '用户中断' };
      if (raw === 'y' || raw === 'yes') return { choice: 'once' };
      if (raw === 'a' || raw === 'always') return { choice: 'always' };

      // Anything else denies; ask why so the model gets a usable reason.
      const feedback = (await this.question('  why (optional, Enter to skip): ', req.signal)).trim();
      return feedback ? { choice: 'deny', feedback } : { choice: 'deny' };
    });
  }

  approve(req: ApproveRequest): Promise<{ approved: boolean; feedback?: string }> {
    return this.enqueue(async () => {
      if (req.signal?.aborted) return { approved: false, feedback: '用户中断' };

      const block = [
        `\n\x1b[1m? ${req.title}\x1b[0m`,
        ...req.body.split('\n').map((l) => `  ${l}`),
        '',
        '  [y] approve and start implementing   [n] revise',
        '> ',
      ].join('\n');

      const raw = (await this.question(block, req.signal)).trim().toLowerCase();
      if (req.signal?.aborted) return { approved: false, feedback: '用户中断' };
      if (raw === 'y' || raw === 'yes') return { approved: true };

      const feedback = (
        await this.question('  what should change (optional): ', req.signal)
      ).trim();
      return feedback ? { approved: false, feedback } : { approved: false };
    });
  }

  askText(query: string, signal?: AbortSignal): Promise<string> {
    return this.enqueue(() => this.question(query, signal));
  }

  close(): void {
    if (this.owned) this.rl.close();
  }
}

export function createPrompter(shared?: Interface): Prompter {
  return new ReadlinePrompter(shared);
}

// ---------------------------------------------------------------------------

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** One-line summary of what a tool call would do, for the approval prompt. */
export function describeToolInput(toolName: string, input: unknown): string {
  const rec = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (toolName.toLowerCase() === 'bash' && typeof rec.command === 'string') return rec.command;
  if (typeof rec.path === 'string') return rec.path;
  return JSON.stringify(input);
}

export interface InteractiveAskOptions {
  /** Called right before a prompt is shown — used to flush a half-open [thinking] block. */
  onBeforePrompt?: () => void;
  /** Echoes the "+ allow X (this session)" confirmation line. */
  echo?: (line: string) => void;
}

/**
 * Turn a {@link Prompter} into an {@link AskHandler}: show the call, map the
 * choice, and on "always" append a whole-tool allow rule to the engine so the
 * same tool isn't asked again this session.
 */
export function interactiveAskHandler(
  engine: Pick<PermissionEngine, 'addAllowRule'>,
  prompter: Prompter,
  opts: InteractiveAskOptions = {},
): AskHandler {
  return async ({ toolName, input, reason, signal }) => {
    opts.onBeforePrompt?.();
    const label = capitalize(toolName);
    const res = await prompter.confirm({
      title: capitalize(reason),
      detail: describeToolInput(toolName, input),
      alwaysLabel: label,
      ...(signal ? { signal } : {}),
    });
    if (res.choice === 'once') return { decision: 'allow' };
    if (res.choice === 'always') {
      engine.addAllowRule(label);
      opts.echo?.(`+ allow ${label} (this session)`);
      return { decision: 'allow' };
    }
    return {
      decision: 'deny',
      reason: res.feedback ? `User declined: ${res.feedback}` : 'User declined this call.',
    };
  };
}
