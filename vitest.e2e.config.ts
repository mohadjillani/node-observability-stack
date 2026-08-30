import { defineConfig } from 'vitest/config';

// The end-to-end suite runs against the compose stack (CI's e2e job):
//   docker compose up --build --wait && E2E=1 npm run test:e2e
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
