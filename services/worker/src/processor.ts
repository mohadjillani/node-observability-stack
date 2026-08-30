import { withConsumerSpan, type TraceCarrier } from '@mohadjillani/telemetry';
import { trace } from '@opentelemetry/api';
import type { OrderWriter } from './db.js';
import type { Logger } from './logger.js';
import type { PricingClient } from './pricing-client.js';

/** Mirrors the api's `OrderJobData`; the queue is the contract between them. */
export interface OrderJobData {
  readonly orderId: string;
  readonly sku: string;
  readonly quantity: number;
  readonly traceContext?: TraceCarrier;
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
  readonly queueName: string;
  readonly writer: OrderWriter;
  readonly pricing: PricingClient;
  readonly logger: Logger;
}

export interface ProcessResult {
  readonly totalCents: number;
}

const tracer = trace.getTracer('worker');

export function createProcessor(
  deps: ProcessorDependencies,
): (job: OrderJob) => Promise<ProcessResult> {
  const { queueName, writer, pricing, logger } = deps;
  return (job) =>
    // Everything inside runs under the consumer span, which continues the
    // trace the api started: the pricing call, the UPDATE and the log lines
    // all land in it.
    withConsumerSpan(
      tracer,
      {
        queue: queueName,
        jobName: job.name,
        jobId: job.id,
        attempt: job.attemptsMade + 1,
        enqueuedAt: job.timestamp,
        data: job.data,
      },
      async () => {
        const { orderId, sku, quantity } = job.data;
        logger.info({ orderId, jobId: job.id, attempt: job.attemptsMade + 1 }, 'processing order');

        const quote = await pricing.quote(sku, quantity);
        await writer.markPriced(orderId, quote.totalCents);

        logger.info({ orderId, jobId: job.id, totalCents: quote.totalCents }, 'order priced');
        return { totalCents: quote.totalCents };
      },
    );
}
