import { createMetrics } from '@mohadjillani/telemetry';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { OrderWriter } from '../src/db.js';
import { createPricingClient, PricingRequestError } from '../src/pricing-client.js';
import { createProcessor, type OrderJob } from '../src/processor.js';
import { createSummariser } from '../src/summariser.js';

const logger = pino({ level: 'silent' });
const metrics = () => createMetrics({ service: 'worker-test', defaultMetrics: false });

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
    const jobMetrics = metrics();
    const process = createProcessor({
      queueName: 'orders',
      writer: store,
      pricing,
      logger,
      metrics: jobMetrics,
    });

    await expect(process(job())).resolves.toEqual({ totalCents: 300 });
    expect(store.priced).toEqual([['o-1', 300]]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await jobMetrics.render()).toMatch(
      /queue_job_duration_seconds_count\{[^}]*queue="orders",name="order.process",outcome="completed"[^}]*\} 1/,
    );
  });

  it('rethrows a pricing failure without touching the row, so the queue retries', async () => {
    const store = writer();
    const pricing = createPricingClient('http://api.test', () =>
      Promise.resolve(new Response('{"error":"pricing_unavailable"}', { status: 503 })),
    );
    const jobMetrics = metrics();
    const process = createProcessor({
      queueName: 'orders',
      writer: store,
      pricing,
      logger,
      metrics: jobMetrics,
    });

    await expect(process(job({ sku: 'FAIL-1' }))).rejects.toBeInstanceOf(PricingRequestError);
    expect(store.priced).toEqual([]);
    expect(store.failed).toEqual([]);
    expect(await jobMetrics.render()).toMatch(
      /queue_job_duration_seconds_count\{[^}]*queue="orders",name="order.process",outcome="failed"[^}]*\} 1/,
    );
  });

  it('adds the handling note and records the model call', async () => {
    const store = writer();
    const pricing = createPricingClient('http://api.test', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ sku: 'ABC-1', quantity: 2, unitCents: 150, totalCents: 300 }),
        ),
      ),
    );
    const jobMetrics = createMetrics({
      service: 'worker-test',
      defaultMetrics: false,
      modelPrices: { 'demo-small': { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 } },
    });
    const process = createProcessor({
      queueName: 'orders',
      writer: store,
      pricing,
      summarise: createSummariser({ metrics: jobMetrics, tokenLatencyMs: 0 }),
      logger,
      metrics: jobMetrics,
    });

    const result = await process(job());

    expect(result.totalCents).toBe(300);
    expect(typeof result.note).toBe('string');
    const rendered = await jobMetrics.render();
    expect(rendered).toMatch(/gen_ai_client_token_usage_count\{[^}]*gen_ai_token_type="output"/);
    expect(rendered).toContain('model_cost_usd_total');
  });

  it('keeps a priced order when the summary fails, and records the failure', async () => {
    const store = writer();
    const pricing = createPricingClient('http://api.test', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ sku: 'FAIL-9', quantity: 2, unitCents: 150, totalCents: 300 }),
        ),
      ),
    );
    const jobMetrics = metrics();
    const process = createProcessor({
      queueName: 'orders',
      writer: store,
      pricing,
      // `FAIL-` makes the summariser throw, the way it makes pricing throw.
      summarise: createSummariser({ metrics: jobMetrics, tokenLatencyMs: 0 }),
      logger,
      metrics: jobMetrics,
    });

    // Retrying would re-price an order that is already priced, so the note is
    // dropped rather than the job.
    const result = await process(job({ sku: 'FAIL-9' }));

    expect(result.note).toBeUndefined();
    expect(store.priced).toEqual([['o-1', 300]]);
    expect(await jobMetrics.render()).toMatch(
      /gen_ai_client_operation_duration_seconds_count\{[^}]*error_type="SummaryUnavailableError"/,
    );
  });
});
