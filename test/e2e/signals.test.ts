import { looksHighCardinality } from '@mohadjillani/telemetry';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  alertRuleNames,
  createOrder,
  getTrace,
  grafanaJson,
  labelValues,
  pollUntil,
  queryExemplars,
  queryLoki,
  queryPrometheus,
  searchTraces,
  waitForOrderStatus,
  type TempoSpan,
} from './stack.js';

const enabled = process.env.E2E === '1';
if (!enabled) console.log('e2e: skipped (set E2E=1 with the compose stack up)');

/**
 * The three signals are connected, and this proves it against the real
 * backends: one order → its log lines in Loki carry a trace id → that trace
 * in Tempo spans both services with the queue link → a Prometheus exemplar
 * points at a trace Tempo has. Runs in CI's e2e job after `compose up`.
 */
describe.skipIf(!enabled)('signals across the compose stack', () => {
  // A SLOW- sku: the pricing hop takes 1.5 s, which puts the trace over the
  // tail sampler's 500 ms latency policy, so it is kept deterministically.
  // A fast, successful order would only survive the 20% baseline policy.
  const sku = `SLOW-E2E-${String(Date.now())}`;
  let orderId: string;
  let traceId: string;
  let spans: TempoSpan[];

  beforeAll(async () => {
    orderId = await createOrder(sku, 2);
    await waitForOrderStatus(orderId, 'priced');
  });

  it('logs → trace: the order’s log lines in Loki carry one trace id', async () => {
    const lines = await pollUntil(`loki lines for order ${orderId}`, async () => {
      const found = await queryLoki(`{service="api"} |= "${orderId}"`);
      return found.length >= 2 ? found : undefined;
    });
    const ids = new Set(lines.map((line) => line.trace_id));
    expect(ids.size).toBe(1);
    traceId = lines[0]?.trace_id ?? '';
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('trace: Tempo has it, spanning api → queue → worker → api with the queue link', async () => {
    spans = await pollUntil(`trace ${traceId} in tempo`, () => getTrace(traceId));
    const services = new Set(spans.map((span) => span.service));
    expect(services).toEqual(new Set(['api', 'worker']));

    const producer = spans.find((span) => span.kind === 'SPAN_KIND_PRODUCER');
    const consumer = spans.find((span) => span.kind === 'SPAN_KIND_CONSUMER');
    expect(producer?.service).toBe('api');
    expect(consumer?.service).toBe('worker');
    expect(consumer?.parentSpanId).toBe(producer?.spanId);
    expect(consumer?.links.map((link) => link.spanId)).toContain(producer?.spanId);

    const pricing = spans.find(
      (span) =>
        span.service === 'api' &&
        span.kind === 'SPAN_KIND_SERVER' &&
        span.attributes['http.route'] === '/internal/pricing',
    );
    expect(pricing).toBeDefined();
    const pricingParent = spans.find((span) => span.spanId === pricing?.parentSpanId);
    expect(pricingParent?.service).toBe('worker');
    expect(pricingParent?.kind).toBe('SPAN_KIND_CLIENT');
  });

  it('trace → logs: Loki returns both services’ lines by trace_id structured metadata', async () => {
    const lines = await pollUntil(`loki lines for trace ${traceId}`, async () => {
      const found = await queryLoki(`{service=~"api|worker"} | trace_id = "${traceId}"`);
      return found.some((line) => line.service === 'worker') ? found : undefined;
    });
    expect(new Set(lines.map((line) => line.service))).toEqual(new Set(['api', 'worker']));
    expect(lines.map((line) => line.msg)).toEqual(
      expect.arrayContaining([
        'order created',
        'order enqueued',
        'processing order',
        'order priced',
      ]),
    );
    for (const line of lines) expect(line.trace_id).toBe(traceId);
  });

  it('metrics → trace: a /orders histogram exemplar points at a trace Tempo has', async () => {
    const exemplars = await pollUntil('exemplars on the /orders histogram', async () => {
      const found = await queryExemplars(
        'http_server_request_duration_seconds_bucket{route="/orders"}',
      );
      return found.length > 0 ? found : undefined;
    });
    const sampled = exemplars.slice(-5);
    let opened = 0;
    for (const exemplar of sampled) {
      expect(exemplar.traceId).toMatch(/^[0-9a-f]{32}$/);
      if (await getTrace(exemplar.traceId)) opened += 1;
    }
    // Tail sampling drops a share of the fast, successful traces, so not
    // every exemplar resolves — but the link has to work for some of them.
    expect(opened).toBeGreaterThan(0);
  });

  it('metrics: route labels are templates only, whatever break-it sent', async () => {
    const routes = await labelValues('route');
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.filter(looksHighCardinality)).toEqual([]);
  });

  it('sampling: a failing order’s trace is kept with its error status', async () => {
    const failing = await createOrder(`FAIL-${String(Date.now())}`, 1);
    const traceIds = await pollUntil('an error trace from the worker', async () => {
      const found = await searchTraces('{ resource.service.name = "worker" && status = error }');
      return found.length > 0 ? found : undefined;
    });
    expect(traceIds.length).toBeGreaterThan(0);
    const failed = await pollUntil('a failed job in the queue metrics', async () => {
      const rows = await queryPrometheus('sum(queue_job_duration_seconds_count{outcome="failed"})');
      return rows[0] && rows[0].value > 0 ? rows[0].value : undefined;
    });
    expect(failed).toBeGreaterThan(0);
    expect(failing).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('alerting and grafana are provisioned', async () => {
    expect(await alertRuleNames()).toEqual(
      expect.arrayContaining([
        'HighErrorRate',
        'HighLatencyP95',
        'QueueBacklog',
        'WorkerStalledJobs',
        'WorkerAbsent',
        'CollectorExportFailing',
      ]),
    );
    const datasources = await grafanaJson<{ uid: string }[]>('/api/datasources');
    expect(datasources.map((datasource) => datasource.uid).sort()).toEqual([
      'loki',
      'prometheus',
      'tempo',
    ]);
    for (const uid of ['nos-red', 'nos-queues', 'nos-drilldown']) {
      const dashboard = await grafanaJson<{ dashboard: { uid: string } }>(
        `/api/dashboards/uid/${uid}`,
      );
      expect(dashboard.dashboard.uid).toBe(uid);
    }
    const correlations = await grafanaJson<unknown[]>('/api/datasources/uid/loki/correlations');
    expect(correlations.length).toBeGreaterThan(0);
  });
});
