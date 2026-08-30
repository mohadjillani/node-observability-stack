import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SpanKind,
  startOtlpReceiver,
  type OtlpReceiver,
  type ReceivedSpan,
} from './otlp-receiver.js';
import { startService, type ServiceProcess } from './service-process.js';

const REDIS_URL = process.env.REDIS_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const enabled = Boolean(REDIS_URL && DATABASE_URL);

if (!enabled) {
  console.log('trace-across-queue: skipped (set REDIS_URL and DATABASE_URL to run it)');
}

/**
 * The headline: one order, four hops — api request → queue → worker →
 * api again — as real processes started the way the images start them,
 * exporting to this test standing in for the Collector. One trace id has
 * to cover all of it, the consumer span has to link to the producer span,
 * and every log line the services wrote for that order has to carry the
 * same trace id.
 */
describe.skipIf(!enabled)('a trace across the queue hop', () => {
  const queueName = `orders-it-${String(process.pid)}`;
  let receiver: OtlpReceiver;
  let api: ServiceProcess;
  let worker: ServiceProcess;
  let apiUrl: string;

  beforeAll(async () => {
    receiver = await startOtlpReceiver();
    const shared = {
      DATABASE_URL,
      REDIS_URL,
      QUEUE_NAME: queueName,
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
      // Export quickly instead of on the 5 s default schedule.
      OTEL_BSP_SCHEDULE_DELAY: '200',
      LOG_LEVEL: 'info',
    };
    api = startService('api', { ...shared, PORT: '0', SLOW_PRICING_MS: '0' });
    const listening = await api.waitForLog('api listening');
    apiUrl = `http://127.0.0.1:${String(listening.port)}`;
    worker = startService('worker', { ...shared, API_URL: apiUrl, WORKER_CONCURRENCY: '2' });
    await worker.waitForLog('worker ready');
  }, 30_000);

  afterAll(async () => {
    const codes = await Promise.all([worker?.stop(), api?.stop()]);
    await receiver?.close();
    if (REDIS_URL) {
      const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
      await new Queue(queueName, { connection }).obliterate({ force: true });
      await connection.quit();
    }
    expect(codes, 'both services exit 0 on SIGTERM').toEqual([0, 0]);
  }, 30_000);

  it('keeps one trace id from the request through the queue to the pricing call back', async () => {
    const created = await fetch(`${apiUrl}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sku: 'ABC-1', quantity: 2 }),
    });
    expect(created.status).toBe(202);
    const { id: orderId } = (await created.json()) as { id: string };

    await pollUntil(async () => {
      const order = (await (await fetch(`${apiUrl}/orders/${orderId}`)).json()) as {
        status: string;
      };
      return order.status === 'priced';
    }, 'order priced');

    // --- spans: every hop, one trace ---------------------------------------
    const isOrderRequest = (span: ReceivedSpan) =>
      span.service === 'api' &&
      span.kind === SpanKind.SERVER &&
      span.attributes['http.route'] === '/orders';
    const isPricingRequest = (span: ReceivedSpan) =>
      span.service === 'api' &&
      span.kind === SpanKind.SERVER &&
      span.attributes['http.route'] === '/internal/pricing';
    const isProducer = (span: ReceivedSpan) =>
      span.service === 'api' && span.kind === SpanKind.PRODUCER;
    const isConsumer = (span: ReceivedSpan) =>
      span.service === 'worker' && span.kind === SpanKind.CONSUMER;

    await receiver.waitFor(
      (spans) =>
        spans.some(isOrderRequest) &&
        spans.some(isProducer) &&
        spans.some(isConsumer) &&
        spans.some(isPricingRequest),
    );

    const orderRequest = find(receiver.spans, isOrderRequest);
    const producer = find(receiver.spans, isProducer);
    const consumer = find(receiver.spans, isConsumer);
    const pricingRequest = find(receiver.spans, isPricingRequest);
    const traceId = orderRequest.traceId;
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);

    expect([producer, consumer, pricingRequest].map((span) => span.traceId)).toEqual([
      traceId,
      traceId,
      traceId,
    ]);

    // Producer under the request, consumer under the producer (continued trace) and linked to it.
    expect(ancestors(receiver.spans, producer)).toContain(orderRequest.spanId);
    expect(consumer.parentSpanId).toBe(producer.spanId);
    expect(consumer.links).toEqual([{ traceId, spanId: producer.spanId }]);
    expect(consumer.name).toBe(`${queueName} process`);
    expect(consumer.attributes).toMatchObject({
      'messaging.system': 'bullmq',
      'messaging.destination.name': queueName,
      'messaging.bullmq.job.name': 'order.process',
    });

    // The worker's HTTP call carried the context back into the api.
    const pricingClient = find(
      receiver.spans,
      (span) =>
        span.service === 'worker' &&
        span.kind === SpanKind.CLIENT &&
        span.traceId === traceId &&
        JSON.stringify(span.attributes).includes('/internal/pricing'),
    );
    expect(ancestors(receiver.spans, pricingClient)).toContain(consumer.spanId);
    expect(pricingRequest.parentSpanId).toBe(pricingClient.spanId);

    // Auto-instrumentation saw the ESM imports: database and Redis spans in the same trace.
    const inTrace = receiver.spans.filter((span) => span.traceId === traceId);
    expect(
      inTrace.some((span) => span.service === 'api' && isDatabaseSpan(span, 'postgresql')),
    ).toBe(true);
    expect(
      inTrace.some((span) => span.service === 'worker' && isDatabaseSpan(span, 'postgresql')),
    ).toBe(true);
    expect(inTrace.some((span) => span.service === 'api' && isDatabaseSpan(span, 'redis'))).toBe(
      true,
    );

    // --- logs: same trace id on every line about this order ----------------
    const apiLines = api.logs.filter((line) => line.orderId === orderId);
    const workerLines = worker.logs.filter((line) => line.orderId === orderId);
    expect(apiLines.map((line) => line.msg)).toEqual(['order created', 'order enqueued']);
    expect(workerLines.map((line) => line.msg)).toEqual(['processing order', 'order priced']);
    for (const line of [...apiLines, ...workerLines]) {
      expect(line.trace_id, `trace_id on "${String(line.msg)}"`).toBe(traceId);
      expect(line.span_id).toMatch(/^[0-9a-f]{16}$/);
    }
    // Each line's span_id is a real span of this trace, under the hop that
    // wrote it: the api's lines under the order request (the handler runs in
    // Express's request-handler span), the worker's directly in the consumer
    // span, and the quote line under the pricing request.
    const underSpan = (spanId: unknown, ancestor: ReceivedSpan) => {
      const span = find(receiver.spans, (candidate) => candidate.spanId === spanId);
      return (
        span.spanId === ancestor.spanId || ancestors(receiver.spans, span).includes(ancestor.spanId)
      );
    };
    for (const line of apiLines) expect(underSpan(line.span_id, orderRequest)).toBe(true);
    expect(workerLines[0]?.span_id).toBe(consumer.spanId);
    expect(workerLines[1]?.span_id).toBe(consumer.spanId);
    const quoteLine = api.logs.find(
      (line) => line.msg === 'quote computed' && line.trace_id === traceId,
    );
    expect(underSpan(quoteLine?.span_id, pricingRequest)).toBe(true);
  }, 45_000);
});

function find(
  spans: readonly ReceivedSpan[],
  predicate: (span: ReceivedSpan) => boolean,
): ReceivedSpan {
  const span = spans.find(predicate);
  if (!span) throw new Error('span not found');
  return span;
}

/** Span ids from the parent upwards to the root. */
function ancestors(spans: readonly ReceivedSpan[], span: ReceivedSpan): string[] {
  const byId = new Map(spans.map((candidate) => [candidate.spanId, candidate]));
  const chain: string[] = [];
  let current = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
  while (current && chain.length < 50) {
    chain.push(current.spanId);
    current = current.parentSpanId ? byId.get(current.parentSpanId) : undefined;
  }
  return chain;
}

function isDatabaseSpan(span: ReceivedSpan, system: string): boolean {
  return (
    span.kind === SpanKind.CLIENT &&
    (span.attributes['db.system.name'] === system || span.attributes['db.system'] === system)
  );
}

async function pollUntil(
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
