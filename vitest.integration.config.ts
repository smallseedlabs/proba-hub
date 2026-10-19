import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    env: {
      OUTBOX_POLL_MS: '50', // Fast polling for tests
    }
  }
});
