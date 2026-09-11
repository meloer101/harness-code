import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20_000,
    projects: [
      {
        test: {
          name: 'node',
          include: [
            'packages/*/src/**/*.test.ts',
            'packages/*/src/**/*.test.tsx',
            'packages/*/test/**/*.test.ts',
            'evals/src/**/*.test.ts',
          ],
          exclude: ['packages/web/**', '**/node_modules/**'],
          environment: 'node',
          testTimeout: 20_000,
        },
      },
      {
        // The browser UI: DOM globals + the `@/` alias from packages/web.
        resolve: {
          alias: { '@': fileURLToPath(new URL('./packages/web/src', import.meta.url)) },
        },
        test: {
          name: 'web',
          include: ['packages/web/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          testTimeout: 20_000,
        },
      },
    ],
  },
});
