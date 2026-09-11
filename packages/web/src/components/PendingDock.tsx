import { ClipboardList, ShieldQuestion } from 'lucide-react';

import { describeToolInput } from '@harness-code/core/browser';

import { Button } from '@/components/ui/button';
import type { SessionViewState } from '@/lib/sessionModel';
import { useSync } from '@/lib/syncContext';

/**
 * Human-in-the-loop prompts, docked above the composer (opencode-style, no
 * modal). Minimal for now — feedback text and y/a/n shortcuts come with the
 * M5 batch 2 polish.
 */
export function PendingDock({ view }: { view: SessionViewState }) {
  const sync = useSync();
  const { pendingAsk, askId, pendingPlan, planId } = view;

  if (pendingAsk && askId) {
    const summary = describeToolInput(pendingAsk.toolName, pendingAsk.input);
    return (
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
        <div className="flex items-center gap-2 font-medium">
          <ShieldQuestion className="size-4 text-amber-500" />
          Allow <span className="font-mono">{pendingAsk.toolName}</span>?
        </div>
        {summary && (
          <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-xs whitespace-pre-wrap">
            {summary}
          </pre>
        )}
        {pendingAsk.reason && <p className="mt-2 text-xs text-muted-foreground">{pendingAsk.reason}</p>}
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={() => void sync.answerAsk(view.id, askId, 'once')}>
            Allow once
          </Button>
          <Button size="sm" variant="outline" onClick={() => void sync.answerAsk(view.id, askId, 'always')}>
            Always allow
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void sync.answerAsk(view.id, askId, 'deny')}>
            Deny
          </Button>
        </div>
      </div>
    );
  }

  if (pendingPlan && planId) {
    return (
      <div className="rounded-xl border border-sky-500/40 bg-sky-500/5 p-3 text-sm">
        <div className="flex items-center gap-2 font-medium">
          <ClipboardList className="size-4 text-sky-500" />
          {pendingPlan.title || 'Plan ready for review'}
        </div>
        <div className="mt-2 max-h-72 overflow-auto rounded-md bg-muted/60 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap">
          {pendingPlan.body}
        </div>
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={() => void sync.answerPlan(view.id, planId, true)}>
            Approve
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void sync.answerPlan(view.id, planId, false)}>
            Reject
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
