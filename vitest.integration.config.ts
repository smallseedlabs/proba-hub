import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    poolOptions: {
      threads: {
        singleThread: true, // Run tests sequentially to avoid database conflicts
      },
    },
    env: {
      OUTBOX_POLL_MS: '50', // Fast polling for tests
    }
  }
});
