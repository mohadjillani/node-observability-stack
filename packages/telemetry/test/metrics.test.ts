import { EventEmitter } from 'node:events';
import { context, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activeExemplar,
  createMetrics,
  findHighCardinalityLabels,
  looksHighCardinality,
  routeTemplate,
  UNMATCHED_ROUTE,
} from '../src/metrics.js';

const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
});
const tracer = trace.getTracer('metrics-test');

beforeAll(() => {
  provider.register();
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});

describe('routeTemplate', () => {
  it('returns the matched Express template, never the concrete path', () => {
    expect(routeTemplate({ method: 'GET', route: { path: '/orders/:id' } })).toBe('/orders/:id');
    expect(routeTemplate({ method: 'GET', baseUrl: '/v1', route: { path: '/orders/:id' } })).toBe(
      '/v1/orders/:id',
    );
    expect(routeTemplate({ method: 'GET', baseUrl: '/v1/', route: { path: '/' } })).toBe('/v1');
    expect(routeTemplate({ method: 'GET', route: { path: '/' } })).toBe('/');
  });

  it('reports unmatched requests under one label instead of their path', () => {
    expect(routeTemplate({ method: 'GET' })).toBe(UNMATCHED_ROUTE);
    expect(routeTemplate({ method: 'GET', route: {} })).toBe(UNMATCHED_ROUTE);
    expect(routeTemplate({ method: 'GET', route: { path: /^\/re/ } })).toBe(UNMATCHED_ROUTE);
  });
});

describe('cardinality guard', () => {
  it('recognises ids and raw paths', () => {
    expect(looksHighCardinality('/orders/6f1c9d1e-0b7a-4c1e-9a1f-1e2d3c4b5a69')).toBe(true);
    expect(looksHighCardinality('/orders/12345')).toBe(true);
    expect(looksHighCardinality('/sessions/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b')).toBe(true);
    expect(looksHighCardinality('/orders/:id')).toBe(false);
    expect(looksHighCardinality('/v1/orders')).toBe(false);
    expect(looksHighCardinality(UNMATCHED_ROUTE)).toBe(false);
  });

  it('flags offending series in rendered output but ignores exemplar labels', () => {
    const rendered = [
      'http_server_request_duration_seconds_count{method="GET",route="/orders/:id",status_code="200"} 1',
      'http_server_request_duration_seconds_count{method="GET",route="/orders/6f1c9d1e-0b7a-4c1e-9a1f-1e2d3c4b5a69",status_code="200"} 1',
      'http_server_request_duration_seconds_bucket{le="0.1",route="/orders"} 1 # {trace_id="6f1c9d1e0b7a4c1e9a1f1e2d3c4b5a69",span_id="1e2d3c4b5a696f1c"} 0.01 1.7e9',
    ].join('\n');
    expect(findHighCardinalityLabels(rendered)).toEqual([
      'http_server_request_duration_seconds_count{method="GET",route="/orders/6f1c9d1e-0b7a-4c1e-9a1f-1e2d3c4b5a69",status_code="200"}',
    ]);
  });
});

interface FakeResponse extends EventEmitter {
  statusCode: number;
}

function fakeResponse(statusCode: number): FakeResponse {
  const response = new EventEmitter() as FakeResponse;
  response.statusCode = statusCode;
  return response;
}

describe('createMetrics', () => {
  it('records requests by route template with an exemplar from the active span', async () => {
    const metrics = createMetrics({ service: 'api', defaultMetrics: false });
    const middleware = metrics.httpMiddleware();

    let expected: { traceId: string; spanId: string } | undefined;
    tracer.startActiveSpan('POST /orders', (span) => {
      expected = { traceId: span.spanContext().traceId, spanId: span.spanContext().spanId };
      const response = fakeResponse(202);
      middleware({ method: 'POST', route: { path: '/orders' } }, response, () => undefined);
      response.emit('finish');
      span.end();
    });

    // Outside any span: counted, no exemplar.
    const plain = fakeResponse(404);
    middleware({ method: 'GET' }, plain, () => undefined);
    plain.emit('finish');

    const rendered = await metrics.render();
    expect(metrics.contentType).toContain('application/openmetrics-text');
    expect(rendered).toContain('service="api"');
    expect(rendered).toMatch(
      /http_server_request_duration_seconds_count\{[^}]*method="POST",route="\/orders",status_code="202"[^}]*\} 1/,
    );
    expect(rendered).toMatch(
      /http_server_request_duration_seconds_count\{[^}]*method="GET",route="unmatched",status_code="404"[^}]*\} 1/,
    );
    expect(rendered).toContain(
      `# {trace_id="${expected?.traceId ?? ''}",span_id="${expected?.spanId ?? ''}"}`,
    );
    expect(findHighCardinalityLabels(rendered)).toEqual([]);
  });

  it('leaves probes and the scrape endpoint out of the request histogram', async () => {
    const metrics = createMetrics({ service: 'api', defaultMetrics: false });
    const middleware = metrics.httpMiddleware();
    for (const path of ['/metrics', '/healthz', '/readyz']) {
      const response = fakeResponse(200);
      middleware({ method: 'GET', route: { path } }, response, () => undefined);
      response.emit('finish');
    }
    const rendered = await metrics.render();
    expect(rendered).not.toContain('route="/metrics"');
    expect(rendered).not.toContain('route="/healthz"');
    expect(rendered).toContain('http_server_active_requests{service="api"} 0');
  });

  it('records job outcomes, stalls and queue depth', async () => {
    const metrics = createMetrics({
      service: 'worker',
      defaultMetrics: false,
      queueDepth: () =>
        Promise.resolve([
          { queue: 'orders', state: 'waiting', count: 3 },
          { queue: 'orders', state: 'failed', count: 1 },
        ]),
    });

    let expected: string | undefined;
    tracer.startActiveSpan('orders process', (span) => {
      expected = span.spanContext().traceId;
      metrics.observeJob({
        queue: 'orders',
        name: 'order.process',
        outcome: 'completed',
        durationSeconds: 0.2,
      });
      span.end();
    });
    metrics.observeJob({
      queue: 'orders',
      name: 'order.process',
      outcome: 'failed',
      durationSeconds: 1.5,
    });
    metrics.jobStalled('orders');

    const rendered = await metrics.render();
    expect(rendered).toMatch(
      /queue_job_duration_seconds_count\{[^}]*queue="orders",name="order.process",outcome="completed"[^}]*\} 1/,
    );
    expect(rendered).toMatch(
      /queue_job_duration_seconds_count\{[^}]*queue="orders",name="order.process",outcome="failed"[^}]*\} 1/,
    );
    expect(rendered).toContain(`trace_id="${expected ?? ''}"`);
    expect(rendered).toMatch(/queue_jobs_stalled_total\{[^}]*queue="orders"[^}]*\} 1/);
    expect(rendered).toMatch(/queue_depth\{[^}]*queue="orders",state="waiting"[^}]*\} 3/);
    expect(rendered).toMatch(/queue_depth\{[^}]*queue="orders",state="failed"[^}]*\} 1/);
  });

  it('exposes the registry through an http handler with the OpenMetrics content type', async () => {
    const metrics = createMetrics({ service: 'api', defaultMetrics: false });
    const headers: Record<string, string> = {};
    let body = '';
    await metrics.handler()(undefined, {
      setHeader: (name, value) => (headers[name] = value),
      end: (chunk) => (body = chunk),
    });
    expect(headers['content-type']).toBe(metrics.contentType);
    expect(body).toContain('# EOF');
  });

  it('activeExemplar is empty outside a span', () => {
    expect(activeExemplar()).toBeUndefined();
  });
});
