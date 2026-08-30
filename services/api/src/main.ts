import { createLogger, flushLogger, shutdownTelemetry } from '@mohadjillani/telemetry';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { createOrdersQueue } from './queue.js';

const config = loadConfig();
const logger = createLogger({
  service: process.env.OTEL_SERVICE_NAME ?? 'api',
  level: config.LOG_LEVEL,
});

const store = createDatabase(config.DATABASE_URL);
await store.migrate();
const queue = createOrdersQueue({ redisUrl: config.REDIS_URL, queueName: config.QUEUE_NAME });

const app = createApp({ store, queue, logger, pricing: { slowMs: config.SLOW_PRICING_MS } });
const server = app.listen(config.PORT, config.HOST, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.PORT;
  logger.info({ port, queue: config.QUEUE_NAME }, 'api listening');
});

let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  const deadline = setTimeout(() => {
    logger.error('shutdown deadline hit, exiting');
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS).unref();

  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await queue.close();
  await store.close();
  // Last, so the spans from the requests drained above are exported too.
  await shutdownTelemetry();
  clearTimeout(deadline);
  logger.info('stopped');
  await flushLogger(logger);
  process.exit(0);
}

process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));
