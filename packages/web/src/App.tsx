import { useEffect, useState } from 'react';
import { Loader2, MessageSquarePlus, WifiOff, X } from 'lucide-react';

import { SessionSidebar } from '@/components/SessionSidebar';
import { SessionView } from '@/components/SessionView';
import { Button } from '@/components/ui/button';
import { parseRoute, routeToHash } from '@/lib/route';
import type { Route } from '@/lib/route';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function App() {
  const sync = useSync();
  const route = useRoute();
  const activeId = route.kind === 'session' ? route.id : null;

  const newSession = async (): Promise<void> => {
    const id = await sync.create();
    if (id) window.location.hash = routeToHash({ kind: 'session', id });
  };

  return (
    <div className="flex h-full">
      <SessionSidebar activeId={activeId} onNew={() => void newSession()} />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ConnectionBanner />
        <ErrorBanner />
        {activeId ? <SessionView key={activeId} id={activeId} /> : <Home onNew={() => void newSession()} />}
      </main>
    </div>
  );
}

function Home({ onNew }: { onNew: () => void }) {
  const connected = useAppStore((s) => s.status === 'open');
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
      <p>No session selected</p>
      <Button onClick={onNew} disabled={!connected}>
        <MessageSquarePlus />
        New session
      </Button>
    </div>
  );
}

function ConnectionBanner() {
  const status = useAppStore((s) => s.status);
  if (status === 'open' || status === 'closed') return null;
  if (status === 'unauthorized') {
    return (
      <div className="flex items-center gap-2 border-b bg-red-500/10 px-4 py-2 text-xs text-red-600 dark:text-red-400">
        <WifiOff className="size-3.5" />
        The server rejected this page's token — it has probably restarted. Open the URL that <code>hc web</code> printed.
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
      <Loader2 className="size-3.5 animate-spin" />
      {status === 'connecting' ? 'Connecting…' : 'Connection lost — reconnecting…'}
    </div>
  );
}

function ErrorBanner() {
  const sync = useSync();
  const error = useAppStore((s) => s.error);
  if (!error) return null;
  return (
    <div className="flex items-center gap-2 border-b bg-red-500/10 px-4 py-2 text-xs text-red-600 dark:text-red-400">
      <span className="flex-1">{error}</span>
      <button type="button" onClick={() => sync.dismissError()} aria-label="Dismiss">
        <X className="size-3.5" />
      </button>
    </div>
  );
}
