import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Dev flow (docs/web-frontend.md, M3): run `hc web --no-open --dev-origin
 * http://localhost:5173 --port 4317` in one terminal and `vite` in another.
 * The page talks to its own origin, so `/ws` is proxied to the hc server;
 * `HC_WEB_PORT` overrides the target port.
 */
const serverPort = process.env['HC_WEB_PORT'] ?? '4317';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // `changeOrigin` rewrites `Host` to the hc server so its Host check
      // passes; `Origin` stays the dev origin, allowed via `--dev-origin`.
      '/ws': { target: `ws://127.0.0.1:${serverPort}`, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
