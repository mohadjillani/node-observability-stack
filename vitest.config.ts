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
      // The entry points, the SDK bootstrap and the database/queue adapters
      // only run inside the spawned services in the cross-process test,
      // which v8 coverage cannot see; that test asserts on their output
      // instead. Barrels and declarations have no logic.
      exclude: [
        '**/index.ts',
        '**/*.d.ts',
        '**/main.ts',
        'packages/telemetry/src/sdk.ts',
        'packages/telemetry/src/register.ts',
        'services/*/src/db.ts',
        'services/api/src/queue.ts',
        'services/worker/src/metrics-server.ts',
      ],
      // What the service-less run reaches; the run with Redis and PostgreSQL
      // reports the same because the extra test covers the excluded files.
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
  },
});
