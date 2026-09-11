import { useEffect, useState } from 'react';
import { MessageSquarePlus, TerminalSquare } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { parseRoute } from '@/lib/route';
import type { Route } from '@/lib/route';

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

/**
 * M3 placeholder shell: sidebar + main pane, wired to the hash route. The
 * transport and stores land in M4, the real session UI in M5.
 */
export function App() {
  const route = useRoute();

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className="flex items-center gap-2 px-4 py-3 font-semibold">
          <TerminalSquare className="size-4" />
          hc web
        </div>
        <div className="px-3">
          <Button variant="outline" size="sm" className="w-full justify-start" disabled>
            <MessageSquarePlus />
            New session
          </Button>
        </div>
      </aside>
      <main className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {route.kind === 'session' ? `Session ${route.id}` : 'No session selected'}
      </main>
    </div>
  );
}
