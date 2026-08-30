import { injectTraceContext, withProducerSpan, type TraceCarrier } from '@mohadjillani/telemetry';
import { trace } from '@opentelemetry/api';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const ORDER_JOB = 'order.process';

export interface OrderJobData {
  readonly orderId: string;
  readonly sku: string;
  readonly quantity: number;
  /** W3C trace context of the request that enqueued the job; the worker continues it. */
  readonly traceContext?: TraceCarrier;
}

export interface OrdersQueue {
  readonly name: string;
  /** Enqueues an order for the worker; resolves with the job id. */
  add(data: Omit<OrderJobData, 'traceContext'>): Promise<string>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface QueueOptions {
  readonly redisUrl: string;
  readonly queueName: string;
}

const tracer = trace.getTracer('api');

export function createOrdersQueue(options: QueueOptions): OrdersQueue {
  // BullMQ requires maxRetriesPerRequest: null so a blocked command outlives
  // a Redis hiccup instead of failing the job.
  const connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
  const queue = new Queue<OrderJobData>(options.queueName, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 500 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });

  return {
    name: options.queueName,
    add(data) {
      // The producer span is what the worker's consumer span links to, and
      // its context is what travels in the job data. Redis commands issued
      // by queue.add() become its children through the ioredis instrumentation.
      return withProducerSpan(
        tracer,
        { queue: options.queueName, jobName: ORDER_JOB },
        async (span) => {
          const job = await queue.add(ORDER_JOB, injectTraceContext(data));
          const jobId = job.id ?? 'unknown';
          span.setAttribute('messaging.message.id', jobId);
          return jobId;
        },
      );
    },
    async ping() {
      await connection.ping();
    },
    async close() {
      await queue.close();
      await connection.quit();
    },
  };
}
