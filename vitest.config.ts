import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests import the workspace package from source; the built dist is only
    // for the services' runtime and the images.
    alias: {
      '@mohadjillani/telemetry': fileURLToPath(
        new URL('./packages/telemetry/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    // The e2e suite needs the compose stack; it has its own config and CI job.
    exclude: ['**/node_modules/**', 'test/e2e/**'],
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'services/*/src/**/*.ts'],
      exclude: ['**/index.ts'],
    },
  },
});
