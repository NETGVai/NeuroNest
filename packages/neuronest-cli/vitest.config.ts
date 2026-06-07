import { defineConfig } from 'vitest/config';

// Node-only environment — this package must never depend on Electron or jsdom.
// `numRuns` for property-based tests is configured per-test via fast-check.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
    testTimeout: 30_000,
  },
});
