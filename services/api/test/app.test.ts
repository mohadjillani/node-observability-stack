import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { fakeQueue, fakeStore, json, silentLogger } from './helpers.js';

function testApp(overrides: { slowMs?: number } = {}) {
  const store = fakeStore();
  const queue = fakeQueue();
  const app = createApp({
    store,
    queue,
    logger: silentLogger,
    pricing: { slowMs: overrides.slowMs ?? 0 },
  });
  return { app, store, queue };
}

describe('POST /orders', () => {
  it('stores the order, enqueues it and answers 202 with a Location', async () => {
    const { app, store, queue } = testApp();
    const response = await request(app).post('/orders').send({ sku: 'ABC-1', quantity: 2 });

    expect(response.status).toBe(202);
    const { id, status } = json(response) as { id: string; status: string };
    expect(status).toBe('queued');
    expect(response.headers.location).toBe(`/orders/${id}`);
    expect(store.orders.get(id)?.sku).toBe('ABC-1');
    expect(queue.jobs).toEqual([{ orderId: id, sku: 'ABC-1', quantity: 2 }]);
  });

  it('rejects an invalid body with 400 and the issues', async () => {
    const { app, queue } = testApp();
    const response = await request(app).post('/orders').send({ sku: '', quantity: 0 });

    expect(response.status).toBe(400);
    const { error, issues } = json(response) as { error: string; issues: unknown[] };
    expect(error).toBe('validation');
    expect(issues).toHaveLength(2);
    expect(queue.jobs).toHaveLength(0);
  });

  it('rejects malformed JSON with 400', async () => {
    const { app } = testApp();
    const response = await request(app)
      .post('/orders')
      .set('content-type', 'application/json')
      .send('{"sku":');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_json' });
  });
});

describe('GET /orders/:id', () => {
  it('returns the order', async () => {
    const { app } = testApp();
    const created = await request(app).post('/orders').send({ sku: 'ABC-1', quantity: 1 });
    const { id } = json(created) as { id: string };
    const response = await request(app).get(`/orders/${id}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id, status: 'queued', totalCents: null });
  });

  it('answers 404 for an unknown id and 400 for a malformed one', async () => {
    const { app } = testApp();
    expect((await request(app).get('/orders/6f1c9d1e-0b7a-4c1e-9a1f-1e2d3c4b5a69')).status).toBe(
      404,
    );
    expect((await request(app).get('/orders/123')).status).toBe(400);
  });
});

describe('GET /internal/pricing', () => {
  it('quotes deterministically', async () => {
    const { app } = testApp();
    const first = await request(app).get('/internal/pricing').query({ sku: 'ABC-1', quantity: 3 });
    const second = await request(app).get('/internal/pricing').query({ sku: 'ABC-1', quantity: 3 });
    expect(first.status).toBe(200);
    expect(first.body).toEqual(second.body);
    const quote = json(first) as { unitCents: number; totalCents: number };
    expect(quote.totalCents).toBe(quote.unitCents * 3);
  });

  it('answers 503 for a FAIL- sku and still 200 for a SLOW- one', async () => {
    const { app } = testApp();
    const failed = await request(app)
      .get('/internal/pricing')
      .query({ sku: 'FAIL-1', quantity: 1 });
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: 'pricing_unavailable' });
    const slow = await request(app).get('/internal/pricing').query({ sku: 'SLOW-1', quantity: 1 });
    expect(slow.status).toBe(200);
  });

  it('validates the query', async () => {
    const { app } = testApp();
    const response = await request(app)
      .get('/internal/pricing')
      .query({ sku: 'X', quantity: 'many' });
    expect(response.status).toBe(400);
  });
});

describe('probes', () => {
  it('reports ready only while both dependencies answer', async () => {
    const { app, store, queue } = testApp();
    expect((await request(app).get('/readyz')).body).toEqual({
      status: 'ready',
      checks: { database: 'ok', redis: 'ok' },
    });

    store.failPing = true;
    const degraded = await request(app).get('/readyz');
    expect(degraded.status).toBe(503);
    expect(degraded.body).toEqual({
      status: 'not_ready',
      checks: { database: 'failed', redis: 'ok' },
    });

    queue.failPing = true;
    expect((await request(app).get('/readyz')).body).toEqual({
      status: 'not_ready',
      checks: { database: 'failed', redis: 'failed' },
    });
    expect((await request(app).get('/healthz')).status).toBe(200);
  });

  it('answers 404 as JSON for unknown routes', async () => {
    const { app } = testApp();
    const response = await request(app).get('/nope');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'not_found' });
  });
});
