import { Loader2, MessageSquarePlus, TerminalSquare } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { relativeTime } from '@/lib/format';
import { routeToHash } from '@/lib/route';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';

export function SessionSidebar({ activeId, onNew }: { activeId: string | null; onNew: () => void }) {
  const sessions = useAppStore((s) => s.sessions);
  const info = useAppStore((s) => s.info);
  const connected = useAppStore((s) => s.status === 'open');

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 px-4 pt-3 pb-1 text-sm font-semibold">
        <TerminalSquare className="size-4" />
        hc web
      </div>
      {info && (
        <div className="truncate px-4 pb-3 font-mono text-[11px] text-muted-foreground" title={info.projectRoot}>
          {info.projectRoot}
        </div>
      )}
      <div className="px-3 pb-2">
        <Button variant="outline" size="sm" className="w-full justify-start" onClick={onNew} disabled={!connected}>
          <MessageSquarePlus />
          New session
        </Button>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        {sessions.length === 0 && connected && (
          <p className="px-2 py-4 text-xs text-muted-foreground">No sessions yet.</p>
        )}
        <ul className="space-y-0.5">
          {sessions.map((s) => (
            <li key={s.id}>
              <a
                href={routeToHash({ kind: 'session', id: s.id })}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent',
                  s.id === activeId && 'bg-sidebar-accent text-sidebar-accent-foreground',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{s.title || 'Untitled session'}</span>
                {s.pending ? (
                  <span className="size-2 shrink-0 rounded-full bg-amber-500" title="Waiting for you" />
                ) : s.running ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Running" />
                ) : (
                  <span className="shrink-0 text-[11px] text-muted-foreground">{relativeTime(s.mtimeMs)}</span>
                )}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
