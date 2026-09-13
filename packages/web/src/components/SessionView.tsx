import { useEffect, useMemo } from 'react';
import { Loader2 } from 'lucide-react';

import { Composer } from '@/components/Composer';
import { PendingDock } from '@/components/PendingDock';
import { SessionHeader } from '@/components/SessionHeader';
import { Transcript } from '@/components/Transcript';
import { allCommands } from '@/lib/slash';
import { useAppStore } from '@/lib/store';
import { useSync } from '@/lib/syncContext';

export function SessionView({ id, onNewSession }: { id: string; onNewSession: () => void }) {
  const sync = useSync();
  const view = useAppStore((s) => s.views[id]);
  const connected = useAppStore((s) => s.status === 'open');
  const mcp = useAppStore((s) => s.slash[id]);
  const commands = useMemo(() => allCommands(mcp ?? []), [mcp]);

  useEffect(() => {
    void sync.open(id);
  }, [sync, id]);

  /** `/help` and `/clear` never reach the server — see lib/slash.ts. */
  const send = async (text: string): Promise<boolean> => {
    const command = /^\/(\S+)\s*$/.exec(text.trim())?.[1];
    if (command === 'help') {
      sync.setHelpOpen(true);
      return true;
    }
    if (command === 'clear') {
      onNewSession();
      return true;
    }
    return sync.send(id, text);
  };

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
          disabled={!connected || view.hydrating}
          commands={commands}
          onSend={send}
          onAbort={() => void sync.abort(id)}
        />
      </div>
    </div>
  );
}
