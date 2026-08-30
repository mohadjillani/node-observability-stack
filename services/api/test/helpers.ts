import { pino } from 'pino';
import type { NewOrder, Order, OrdersStore } from '../src/db.js';
import type { OrderJobData, OrdersQueue } from '../src/queue.js';

export interface FakeStore extends OrdersStore {
  readonly orders: Map<string, Order>;
  failPing: boolean;
}

export function fakeStore(): FakeStore {
  const orders = new Map<string, Order>();
  return {
    orders,
    failPing: false,
    insert(order: NewOrder) {
      const now = new Date().toISOString();
      const row: Order = {
        ...order,
        status: 'queued',
        totalCents: null,
        createdAt: now,
        updatedAt: now,
      };
      orders.set(order.id, row);
      return Promise.resolve(row);
    },
    get(id) {
      return Promise.resolve(orders.get(id));
    },
    ping() {
      return this.failPing ? Promise.reject(new Error('db down')) : Promise.resolve();
    },
  };
}

export interface FakeQueue extends OrdersQueue {
  readonly jobs: OrderJobData[];
  failPing: boolean;
}

export function fakeQueue(): FakeQueue {
  const jobs: OrderJobData[] = [];
  return {
    name: 'orders-test',
    jobs,
    failPing: false,
    add(data) {
      jobs.push(data);
      return Promise.resolve(String(jobs.length));
    },
    ping() {
      return this.failPing ? Promise.reject(new Error('redis down')) : Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
}

export const silentLogger = pino({ level: 'silent' });

/** supertest types `body` as `any`; take it as `unknown` and name the shape at the call site. */
export function json(response: { body: unknown }): unknown {
  return response.body;
}
