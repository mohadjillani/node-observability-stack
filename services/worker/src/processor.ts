import {
  withConsumerSpan,
  type JobOutcome,
  type Logger,
  type Metrics,
  type TraceCarrier,
} from '@mohadjillani/telemetry';
import { trace } from '@opentelemetry/api';
import type { OrderWriter } from './db.js';
import type { PricingClient } from './pricing-client.js';
import type { Summary } from './summariser.js';

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
  /** Produces the handling note. Optional so tests can leave it out. */
  readonly summarise?: (sku: string, quantity: number) => Promise<Summary>;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

export interface ProcessResult {
  readonly totalCents: number;
  readonly note?: string | undefined;
}

const tracer = trace.getTracer('worker');

export function createProcessor(
  deps: ProcessorDependencies,
): (job: OrderJob) => Promise<ProcessResult> {
  const { queueName, writer, pricing, summarise, logger, metrics } = deps;
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

        // Observed here rather than on the queue's 'completed' event so the
        // histogram sample carries this consumer span as its exemplar.
        const started = process.hrtime.bigint();
        let outcome: JobOutcome = 'failed';
        try {
          const quote = await pricing.quote(sku, quantity);
          await writer.markPriced(orderId, quote.totalCents);
          outcome = 'completed';
          logger.info({ orderId, jobId: job.id, totalCents: quote.totalCents }, 'order priced');

          // The note is advisory, so a model failure degrades the result
          // rather than the job: retrying a priced order to re-run a summary
          // would re-price it, and the span and the error-typed duration
          // sample have already recorded what went wrong.
          let note: string | undefined;
          if (summarise) {
            try {
              note = (await summarise(sku, quantity)).note;
              logger.info({ orderId, jobId: job.id, note }, 'order summarised');
            } catch (error) {
              logger.warn(
                { orderId, jobId: job.id, err: error },
                'summary unavailable, continuing',
              );
            }
          }

          return { totalCents: quote.totalCents, note };
        } finally {
          metrics.observeJob({
            queue: queueName,
            name: job.name,
            outcome,
            durationSeconds: Number(process.hrtime.bigint() - started) / 1e9,
          });
        }
      },
    );
}
