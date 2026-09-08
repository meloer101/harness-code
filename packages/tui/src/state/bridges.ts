/**
 * Ask / plan bridges as a plain mutable store (no React) — they are *inputs* to
 * `AgentSession.create`, which runs before the app mounts, so they can't be
 * hooks. The app polls `pendingAsk` / `pendingPlan` / `notices` on its flush
 * loop and routes key presses back through `answerAsk` / `answerPlan`.
 */

import type { AskHandler, Notice, PermissionDecision } from '@harness-code/core';

import type { PendingAsk, PendingPlan } from './reducer.js';

export class UiStore {
  pendingAsk: PendingAsk | null = null;
  pendingPlan: PendingPlan | null = null;
  private notices: Notice[] = [];
  private askLabel = '';
  private resolveAsk: ((d: PermissionDecision) => void) | null = null;
  private resolvePlan: ((r: { approved: boolean; feedback?: string }) => void) | null = null;

  constructor(private readonly addAllow: (label: string) => void) {}

  readonly ask: AskHandler = (req) =>
    new Promise<PermissionDecision>((resolve) => {
      this.askLabel = req.toolName;
      this.resolveAsk = resolve;
      this.pendingAsk = { toolName: req.toolName, input: req.input, reason: req.reason };
      req.signal?.addEventListener(
        'abort',
        () => {
          if (this.resolveAsk !== resolve) return;
          this.resolveAsk = null;
          this.pendingAsk = null;
          resolve({ decision: 'deny', reason: 'Aborted' });
        },
        { once: true },
      );
    });

  readonly confirm = (req: { title: string; body: string }) =>
    new Promise<{ approved: boolean; feedback?: string }>((resolve) => {
      this.resolvePlan = resolve;
      this.pendingPlan = { title: req.title, body: req.body };
    });

  pushNotice(n: Notice): void {
    this.notices.push(n);
  }

  drainNotices(): Notice[] {
    const out = this.notices;
    this.notices = [];
    return out;
  }

  answerAsk(v: 'once' | 'always' | 'deny', feedback?: string): void {
    const resolve = this.resolveAsk;
    this.resolveAsk = null;
    this.pendingAsk = null;
    if (!resolve) return;
    if (v === 'always') this.addAllow(this.askLabel);
    resolve(
      v === 'deny'
        ? { decision: 'deny', reason: feedback ? `User declined: ${feedback}` : 'User declined' }
        : { decision: 'allow' },
    );
  }

  answerPlan(approved: boolean, feedback?: string): void {
    const resolve = this.resolvePlan;
    this.resolvePlan = null;
    this.pendingPlan = null;
    resolve?.({ approved, feedback });
  }
}
