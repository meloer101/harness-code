import { ChevronDown } from 'lucide-react';

import { fmtTokens, fmtUSD } from '@harness-code/core/browser';
import type { PermissionMode } from '@harness-code/core';

import { contextLevel } from '@/lib/format';
import type { SessionViewState } from '@/lib/sessionModel';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';
import { cn } from '@/lib/utils';

const MODE_LABELS: Record<PermissionMode, string> = {
  ask: 'Ask',
  plan: 'Plan',
  acceptEdits: 'Accept edits',
  readOnly: 'Read only',
  yolo: 'YOLO',
};

export function SessionHeader({ view }: { view: SessionViewState }) {
  const sync = useSync();
  const modes = useAppStore((s) => s.info?.modes) ?? [view.mode];

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4 text-sm">
      <span className="flex min-w-0 items-center gap-2" title="Model">
        <span className="size-1.5 shrink-0 rounded-full bg-primary" />
        <span className="truncate font-mono text-xs text-muted-foreground">{view.modelRef}</span>
      </span>
      <span className="relative">
        <select
          aria-label="Permission mode"
          className="h-7 cursor-pointer appearance-none rounded-md border bg-card pr-7 pl-2.5 text-xs font-medium shadow-xs transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
          value={view.mode}
          onChange={(e) => void sync.setMode(view.id, e.target.value as PermissionMode)}
        >
          {modes.map((m) => (
            <option key={m} value={m}>
              {MODE_LABELS[m]}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      </span>
      <div className="flex-1" />
      <UsageMeter view={view} />
    </header>
  );
}

function UsageMeter({ view }: { view: SessionViewState }) {
  const { usage, context } = view;
  if (!usage && !context) return null;
  const level = context ? contextLevel(context.ratio) : 'ok';
  const pct = context ? Math.round(context.ratio * 100) : null;

  return (
    <div className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground tabular-nums">
      {usage && (
        <span title="Session tokens in / out">
          ↑{fmtTokens(usage.inputTokens)} ↓{fmtTokens(usage.outputTokens)}
        </span>
      )}
      {usage?.costUSD !== undefined && (
        <span title={usage.estimated ? 'Estimated cost' : 'Session cost'}>
          {usage.estimated ? '~' : ''}
          {fmtUSD(usage.costUSD)}
        </span>
      )}
      {context && pct !== null && (
        <span
          className="flex items-center gap-1.5"
          title={`Context ${fmtTokens(context.usedTokens)} / ${fmtTokens(context.windowTokens)}`}
        >
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
            <span
              className={cn(
                'block h-full rounded-full transition-[width] duration-300',
                level === 'danger' ? 'bg-destructive' : level === 'warn' ? 'bg-brass' : 'bg-primary/50',
              )}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </span>
          <span className={cn(level === 'danger' && 'text-destructive', level === 'warn' && 'text-brass')}>
            {pct}%
          </span>
        </span>
      )}
    </div>
  );
}
