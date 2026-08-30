import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { createLogger } from './logger.js';
import { createPricingClient } from './pricing-client.js';
import { createProcessor, type OrderJobData, type ProcessResult } from './processor.js';

const config = loadConfig();
const logger = createLogger(process.env.OTEL_SERVICE_NAME ?? 'worker', config.LOG_LEVEL);

const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const database = createDatabase(config.DATABASE_URL);
const pricing = createPricingClient(config.API_URL);
const process_ = createProcessor({ writer: database, pricing, logger });

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
worker.on('error', (error) => {
  logger.error({ err: error }, 'worker error');
});
worker.on('ready', () => {
  logger.info({ queue: config.QUEUE_NAME, concurrency: config.WORKER_CONCURRENCY }, 'worker ready');
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

  // close() waits for active jobs to finish before releasing the lock.
  await worker.close();
  await connection.quit();
  await database.close();
  clearTimeout(deadline);
  logger.info('stopped');
  process.exit(0);
}

process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));
