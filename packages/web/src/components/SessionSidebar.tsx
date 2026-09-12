import { Loader2, MessageSquarePlus } from 'lucide-react';

import { ThemeToggle } from '@/components/ThemeToggle';
import { relativeTime } from '@/lib/format';
import { routeToHash } from '@/lib/route';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';

export function SessionSidebar({ activeId, onNew }: { activeId: string | null; onNew: () => void }) {
  const sessions = useAppStore((s) => s.sessions);
  const info = useAppStore((s) => s.info);
  const status = useAppStore((s) => s.status);
  const connected = status === 'open';

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex items-baseline gap-2 px-4 pt-4 pb-0.5">
        <span className="font-serif text-[17px] font-semibold tracking-[-0.01em]">
          hc<span className="text-brass">·</span>web
        </span>
        <span className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">console</span>
      </div>
      {info && (
        <div className="truncate px-4 pt-1 pb-3 font-mono text-[11px] text-muted-foreground" title={info.projectRoot}>
          {info.projectRoot}
        </div>
      )}
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={onNew}
          disabled={!connected}
          className="flex w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm font-medium shadow-xs transition-colors hover:bg-sidebar-accent disabled:pointer-events-none disabled:opacity-50"
        >
          <MessageSquarePlus className="size-4 text-primary" />
          <span className="flex-1 text-left">New session</span>
          <kbd className="font-mono text-[10px] text-muted-foreground">⌘K</kbd>
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pt-1 pb-3">
        {sessions.length === 0 && connected && (
          <p className="px-2 py-6 text-center font-serif text-[13px] text-muted-foreground italic">
            No sessions yet — the first one is a keystroke away.
          </p>
        )}
        <ul className="space-y-0.5">
          {sessions.map((s) => (
            <li key={s.id}>
              <a
                href={routeToHash({ kind: 'session', id: s.id })}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors hover:bg-sidebar-accent',
                  s.id === activeId && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{s.title || 'Untitled session'}</span>
                {s.pending ? (
                  <span className="size-2 shrink-0 rounded-full bg-brass" title="Waiting for you" />
                ) : s.running ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-label="Running" />
                ) : (
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{relativeTime(s.mtimeMs)}</span>
                )}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex items-center justify-between border-t px-3 py-2">
        <ThemeToggle />
        <span
          className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground"
          title={connected ? 'Connected' : 'Disconnected'}
        >
          <span className={cn('size-1.5 rounded-full', connected ? 'bg-success' : 'bg-brass')} />
          {connected ? 'live' : 'offline'}
        </span>
      </div>
    </aside>
  );
}
