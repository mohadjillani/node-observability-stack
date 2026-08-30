import { randomUUID } from 'node:crypto';
import type { Logger, Metrics } from '@mohadjillani/telemetry';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { OrdersStore } from './db.js';
import { PricingUnavailableError, quote, type PricingOptions } from './pricing.js';
import type { OrdersQueue } from './queue.js';

export interface AppDependencies {
  readonly store: OrdersStore;
  readonly queue: OrdersQueue;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly pricing?: PricingOptions;
}

const createOrderBody = z.object({
  sku: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(1_000),
});

const pricingQuery = z.object({
  sku: z.string().min(1).max(64),
  quantity: z.coerce.number().int().min(1).max(1_000),
});

const orderIdParam = z.object({ id: z.uuid() });

export function createApp(deps: AppDependencies): Express {
  const { store, queue, logger, metrics } = deps;
  const app = express();
  app.disable('x-powered-by');
  // First, so every response — including 404s and errors — is counted.
  app.use(metrics.httpMiddleware());
  app.use(express.json({ limit: '16kb' }));

  app.get('/metrics', metrics.handler());

  app.get('/healthz', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.get('/readyz', async (_request, response) => {
    const checks = await Promise.allSettled([store.ping(), queue.ping()]);
    const [database, redis] = checks.map((check) =>
      check.status === 'fulfilled' ? 'ok' : 'failed',
    );
    const ready = checks.every((check) => check.status === 'fulfilled');
    response
      .status(ready ? 200 : 503)
      .json({ status: ready ? 'ready' : 'not_ready', checks: { database, redis } });
  });

  app.post('/orders', async (request, response) => {
    const body = createOrderBody.parse(request.body);
    const order = await store.insert({ id: randomUUID(), ...body });
    logger.info({ orderId: order.id, sku: order.sku }, 'order created');

    const jobId = await queue.add({ orderId: order.id, sku: order.sku, quantity: order.quantity });
    logger.info({ orderId: order.id, jobId, queue: queue.name }, 'order enqueued');

    response
      .status(202)
      .location(`/orders/${order.id}`)
      .json({ id: order.id, status: order.status });
  });

  app.get('/orders/:id', async (request, response) => {
    const { id } = orderIdParam.parse(request.params);
    const order = await store.get(id);
    if (!order) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    response.json(order);
  });

  // The worker calls this back: a second HTTP hop inside the same trace.
  app.get('/internal/pricing', async (request, response) => {
    const { sku, quantity } = pricingQuery.parse(request.query);
    const result = await quote(sku, quantity, deps.pricing ?? {});
    logger.info({ sku, quantity, totalCents: result.totalCents }, 'quote computed');
    response.json(result);
  });

  app.use((_request, response) => {
    response.status(404).json({ error: 'not_found' });
  });

  // Express identifies an error handler by its arity, so the fourth parameter stays.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: 'validation', issues: error.issues });
      return;
    }
    if (error instanceof PricingUnavailableError) {
      logger.warn({ err: error }, 'pricing unavailable');
      response.status(503).json({ error: 'pricing_unavailable' });
      return;
    }
    if (isBodyParseError(error)) {
      response.status(400).json({ error: 'invalid_json' });
      return;
    }
    logger.error({ err: error }, 'unhandled error');
    response.status(500).json({ error: 'internal' });
  });

  return app;
}

function isBodyParseError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    error.type === 'entity.parse.failed'
  );
}
