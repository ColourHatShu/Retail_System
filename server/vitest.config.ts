import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/tests/setup.ts'],
    include: ['src/**/*.test.ts'],
    // Each test file gets its own module graph, pool, and throwaway schema.
    isolate: true,
    // Suites talk to a hosted Postgres over the network.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
