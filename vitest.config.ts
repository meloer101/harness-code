import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.test.tsx',
      'packages/*/test/**/*.test.ts',
      'evals/src/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 20_000,
  },
});
