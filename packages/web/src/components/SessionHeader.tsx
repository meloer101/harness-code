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
      <span className="truncate font-mono text-xs text-muted-foreground" title="Model">
        {view.modelRef}
      </span>
      <select
        aria-label="Permission mode"
        className="h-7 rounded-md border bg-background px-2 text-xs"
        value={view.mode}
        onChange={(e) => void sync.setMode(view.id, e.target.value as PermissionMode)}
      >
        {modes.map((m) => (
          <option key={m} value={m}>
            {MODE_LABELS[m]}
          </option>
        ))}
      </select>
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
    <div className="flex items-center gap-3 font-mono text-xs text-muted-foreground">
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
        <span className="flex items-center gap-1.5" title={`Context ${fmtTokens(context.usedTokens)} / ${fmtTokens(context.windowTokens)}`}>
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
            <span
              className={cn(
                'block h-full rounded-full',
                level === 'danger' ? 'bg-red-500' : level === 'warn' ? 'bg-amber-500' : 'bg-foreground/40',
              )}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </span>
          <span className={cn(level === 'danger' && 'text-red-500', level === 'warn' && 'text-amber-500')}>{pct}%</span>
        </span>
      )}
    </div>
  );
}
