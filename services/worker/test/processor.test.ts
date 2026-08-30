import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { OrderWriter } from '../src/db.js';
import { createPricingClient, PricingRequestError } from '../src/pricing-client.js';
import { createProcessor, type OrderJob } from '../src/processor.js';

const logger = pino({ level: 'silent' });

function writer(): OrderWriter & { priced: [string, number][]; failed: string[] } {
  const priced: [string, number][] = [];
  const failed: string[] = [];
  return {
    priced,
    failed,
    markPriced(id, totalCents) {
      priced.push([id, totalCents]);
      return Promise.resolve();
    },
    markFailed(id) {
      failed.push(id);
      return Promise.resolve();
    },
    ping: () => Promise.resolve(),
  };
}

function job(overrides: Partial<OrderJob['data']> = {}): OrderJob {
  return {
    id: '7',
    name: 'order.process',
    data: { orderId: 'o-1', sku: 'ABC-1', quantity: 2, ...overrides },
    attemptsMade: 0,
    timestamp: Date.now(),
  };
}

describe('createProcessor', () => {
  it('prices the order through the api and writes the total', async () => {
    const store = writer();
    const fetchFn = vi.fn((url: string) => {
      expect(url).toBe('http://api.test/internal/pricing?sku=ABC-1&quantity=2');
      return Promise.resolve(
        new Response(
          JSON.stringify({ sku: 'ABC-1', quantity: 2, unitCents: 150, totalCents: 300 }),
        ),
      );
    });
    const pricing = createPricingClient('http://api.test/', fetchFn);
    const process = createProcessor({ queueName: 'orders', writer: store, pricing, logger });

    await expect(process(job())).resolves.toEqual({ totalCents: 300 });
    expect(store.priced).toEqual([['o-1', 300]]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rethrows a pricing failure without touching the row, so the queue retries', async () => {
    const store = writer();
    const pricing = createPricingClient('http://api.test', () =>
      Promise.resolve(new Response('{"error":"pricing_unavailable"}', { status: 503 })),
    );
    const process = createProcessor({ queueName: 'orders', writer: store, pricing, logger });

    await expect(process(job({ sku: 'FAIL-1' }))).rejects.toBeInstanceOf(PricingRequestError);
    expect(store.priced).toEqual([]);
    expect(store.failed).toEqual([]);
  });
});
