import {
  createLogger,
  createMetrics,
  flushLogger,
  shutdownTelemetry,
} from '@mohadjillani/telemetry';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { startMetricsServer } from './metrics-server.js';
import { createPricingClient } from './pricing-client.js';
import { createProcessor, type OrderJobData, type ProcessResult } from './processor.js';

const config = loadConfig();
const service = process.env.OTEL_SERVICE_NAME ?? 'worker';
const logger = createLogger({ service, level: config.LOG_LEVEL });

const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const database = createDatabase(config.DATABASE_URL);
const pricing = createPricingClient(config.API_URL);

// A Queue handle on the same connection, only for counting: the depth gauge
// is read on every scrape, so a backlog shows up whether or not this worker
// is the one falling behind.
const queue = new Queue(config.QUEUE_NAME, { connection });
const metrics = createMetrics({
  service,
  queueDepth: async () => {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
    return (['waiting', 'active', 'delayed', 'failed', 'completed'] as const).map((state) => ({
      queue: config.QUEUE_NAME,
      state,
      count: counts[state] ?? 0,
    }));
  },
});

const process_ = createProcessor({
  queueName: config.QUEUE_NAME,
  writer: database,
  pricing,
  logger,
  metrics,
});

const worker = new Worker<OrderJobData, ProcessResult>(config.QUEUE_NAME, process_, {
  connection,
  concurrency: config.WORKER_CONCURRENCY,
});

worker.on('failed', (job, error) => {
  if (!job) return;
  const attempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
  const exhausted = job.attemptsMade >= attempts;
  logger.warn(
    { orderId: job.data.orderId, jobId: job.id, attempt: job.attemptsMade, exhausted, err: error },
    exhausted ? 'order failed permanently' : 'order attempt failed, will retry',
  );
  if (exhausted) {
    database.markFailed(job.data.orderId).catch((cause: unknown) => {
      logger.error({ orderId: job.data.orderId, err: cause }, 'could not mark order failed');
    });
  }
});
worker.on('stalled', (jobId) => {
  metrics.jobStalled(config.QUEUE_NAME);
  logger.warn({ jobId }, 'job stalled: lock expired while it was being processed');
});
worker.on('error', (error) => {
  logger.error({ err: error }, 'worker error');
});

const metricsServer = await startMetricsServer(metrics, config.WORKER_METRICS_PORT);
const metricsAddress = metricsServer.address();
const metricsPort =
  typeof metricsAddress === 'object' && metricsAddress
    ? metricsAddress.port
    : config.WORKER_METRICS_PORT;

await worker.waitUntilReady();
logger.info(
  { queue: config.QUEUE_NAME, concurrency: config.WORKER_CONCURRENCY, metricsPort },
  'worker ready',
);

let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  const deadline = setTimeout(() => {
    logger.error('shutdown deadline hit, exiting');
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS).unref();

  // close() waits for active jobs to finish before releasing the lock.
  await worker.close();
  await queue.close();
  await new Promise<void>((resolve) => {
    metricsServer.close(() => {
      resolve();
    });
  });
  await connection.quit();
  await database.close();
  // Last, so the spans of the jobs that just finished are exported too.
  await shutdownTelemetry();
  clearTimeout(deadline);
  logger.info('stopped');
  await flushLogger(logger);
  process.exit(0);
}

process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));
