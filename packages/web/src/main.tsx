import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { SessionSync } from './lib/sync';
import { SyncProvider } from './lib/syncContext';
import { takeToken } from './lib/token';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

const token = takeToken();

if (!token) {
  createRoot(root).render(
    <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
      <p>
        No access token. Open the URL printed by <code className="font-mono">hc web</code> (it ends in{' '}
        <code className="font-mono">#token=…</code>).
      </p>
    </div>,
  );
} else {
  const wsUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
  const sync = new SessionSync({ url: wsUrl, token });
  sync.start();
  // Skip the reconnect backoff when the tab comes back or the network returns.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync.rpc.wake();
  });
  window.addEventListener('online', () => sync.rpc.wake());

  createRoot(root).render(
    <StrictMode>
      <SyncProvider sync={sync}>
        <App />
      </SyncProvider>
    </StrictMode>,
  );
}
