import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

import type { SessionSync } from './sync';

const SyncContext = createContext<SessionSync | null>(null);

export function SyncProvider({ sync, children }: { sync: SessionSync; children: ReactNode }) {
  return <SyncContext.Provider value={sync}>{children}</SyncContext.Provider>;
}

export function useSync(): SessionSync {
  const sync = useContext(SyncContext);
  if (!sync) throw new Error('useSync() outside <SyncProvider>');
  return sync;
}
