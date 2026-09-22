import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/helpers/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
          // One Parse Server per file (Parse keeps process-global state), files in separate forks.
          pool: 'forks',
        },
      },
    ],
  },
});
