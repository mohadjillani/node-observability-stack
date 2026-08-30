import type { OrderWriter } from './db.js';
import type { Logger } from './logger.js';
import type { PricingClient } from './pricing-client.js';

/** Mirrors the api's `OrderJobData`; the queue is the contract between them. */
export interface OrderJobData {
  readonly orderId: string;
  readonly sku: string;
  readonly quantity: number;
}

/** The subset of a BullMQ `Job` the processor reads, so tests can pass a literal. */
export interface OrderJob {
  readonly id?: string | undefined;
  readonly name: string;
  readonly data: OrderJobData;
  readonly attemptsMade: number;
  readonly timestamp: number;
}

export interface ProcessorDependencies {
  readonly writer: OrderWriter;
  readonly pricing: PricingClient;
  readonly logger: Logger;
}

export interface ProcessResult {
  readonly totalCents: number;
}

export function createProcessor(
  deps: ProcessorDependencies,
): (job: OrderJob) => Promise<ProcessResult> {
  const { writer, pricing, logger } = deps;
  return async (job) => {
    const { orderId, sku, quantity } = job.data;
    logger.info({ orderId, jobId: job.id, attempt: job.attemptsMade + 1 }, 'processing order');

    const quote = await pricing.quote(sku, quantity);
    await writer.markPriced(orderId, quote.totalCents);

    logger.info({ orderId, jobId: job.id, totalCents: quote.totalCents }, 'order priced');
    return { totalCents: quote.totalCents };
  };
}
