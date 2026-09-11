import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';

import { Composer } from '@/components/Composer';
import { PendingDock } from '@/components/PendingDock';
import { SessionHeader } from '@/components/SessionHeader';
import { Transcript } from '@/components/Transcript';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';

export function SessionView({ id }: { id: string }) {
  const sync = useSync();
  const view = useAppStore((s) => s.views[id]);
  const connected = useAppStore((s) => s.status === 'open');

  useEffect(() => {
    void sync.open(id);
  }, [sync, id]);

  if (!view) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading session…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SessionHeader view={view} />
      <Transcript view={view} />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 pt-2 pb-5">
        <PendingDock view={view} />
        <Composer
          key={id}
          sessionId={id}
          running={view.running}
          disabled={!connected}
          onSend={(text) => sync.send(id, text)}
          onAbort={() => void sync.abort(id)}
        />
      </div>
    </div>
  );
}
