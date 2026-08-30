import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const ORDER_JOB = 'order.process';

export interface OrderJobData {
  readonly orderId: string;
  readonly sku: string;
  readonly quantity: number;
}

export interface OrdersQueue {
  readonly name: string;
  /** Enqueues an order for the worker; resolves with the job id. */
  add(data: OrderJobData): Promise<string>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface QueueOptions {
  readonly redisUrl: string;
  readonly queueName: string;
}

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
    async add(data) {
      const job = await queue.add(ORDER_JOB, data);
      return job.id ?? 'unknown';
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
