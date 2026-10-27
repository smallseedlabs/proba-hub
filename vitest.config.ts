import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', 'node_modules'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['**/*.test.ts', '**/*.integration.test.ts', 'dist/**']
    }
  }
});
