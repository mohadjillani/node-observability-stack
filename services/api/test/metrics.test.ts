import { findHighCardinalityLabels } from '@mohadjillani/telemetry';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { fakeQueue, fakeStore, silentLogger, testMetrics } from './helpers.js';

/**
 * The guard. Every route label the api can produce is a template or
 * `unmatched`; a concrete id or path in a label would mint one series per
 * order and eventually take Prometheus down with it.
 */
describe('GET /metrics', () => {
  it('labels requests by route template only, whatever the client sends', async () => {
    const metrics = testMetrics();
    const app = createApp({
      store: fakeStore(),
      queue: fakeQueue(),
      logger: silentLogger,
      metrics,
      pricing: { slowMs: 0 },
    });

    const created = await request(app).post('/orders').send({ sku: 'ABC-1', quantity: 1 });
    const { id } = created.body as { id: string };
    await request(app).get(`/orders/${id}`);
    await request(app).get('/orders/6f1c9d1e-0b7a-4c1e-9a1f-1e2d3c4b5a69');
    await request(app).get('/orders/123');
    await request(app).get('/internal/pricing').query({ sku: 'SKU-9f86d081884c7d65', quantity: 2 });
    await request(app).get('/nope/6f1c9d1e-0b7a-4c1e-9a1f-1e2d3c4b5a69/deep');
    await request(app).get(`/orders/${id}/../..//etc/passwd`);
    await request(app).get('/healthz');

    const scrape = await request(app).get('/metrics');
    expect(scrape.status).toBe(200);
    expect(scrape.headers['content-type']).toContain('application/openmetrics-text');
    const rendered = scrape.text;

    const routes = new Set([...rendered.matchAll(/route="([^"]*)"/g)].map((match) => match[1]));
    expect(routes).toEqual(new Set(['/orders', '/orders/:id', '/internal/pricing', 'unmatched']));
    expect(findHighCardinalityLabels(rendered)).toEqual([]);
    expect(rendered).toMatch(
      /http_server_request_duration_seconds_count\{[^}]*method="GET",route="\/orders\/:id",status_code="404"[^}]*\} 1/,
    );
    expect(rendered).toMatch(
      /http_server_request_duration_seconds_count\{[^}]*method="GET",route="\/orders\/:id",status_code="400"[^}]*\} 1/,
    );
    expect(rendered).toMatch(
      /http_server_request_duration_seconds_count\{[^}]*method="GET",route="unmatched",status_code="404"[^}]*\} 2/,
    );
  });
});
