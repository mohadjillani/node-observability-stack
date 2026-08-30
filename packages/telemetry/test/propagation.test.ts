import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  extractTraceContext,
  injectTraceContext,
  withConsumerSpan,
  withProducerSpan,
} from '../src/propagation.js';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const tracer = trace.getTracer('propagation-test');

beforeAll(() => {
  provider.register({ propagator: new W3CTraceContextPropagator() });
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});
beforeEach(() => {
  exporter.reset();
});

function spanNamed(name: string): ReadableSpan {
  const span = exporter.getFinishedSpans().find((candidate) => candidate.name === name);
  if (!span)
    throw new Error(
      `no span named ${name}; have ${exporter
        .getFinishedSpans()
        .map((s) => s.name)
        .join(', ')}`,
    );
  return span;
}

describe('injectTraceContext / extractTraceContext', () => {
  it('round-trips the active span through plain job data', () => {
    tracer.startActiveSpan('request', (span) => {
      const data = injectTraceContext({ orderId: 'o-1' });
      expect(data.orderId).toBe('o-1');
      expect(data.traceContext.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

      // Simulate the JSON hop through Redis.
      const revived = JSON.parse(JSON.stringify(data)) as typeof data;
      const extracted = trace.getSpanContext(extractTraceContext(revived));
      expect(extracted?.traceId).toBe(span.spanContext().traceId);
      expect(extracted?.spanId).toBe(span.spanContext().spanId);
      expect(extracted?.isRemote).toBe(true);
      span.end();
    });
  });

  it('yields a context without a span for data that carries none', () => {
    expect(trace.getSpanContext(extractTraceContext({ orderId: 'x' }))).toBeUndefined();
    expect(trace.getSpanContext(extractTraceContext(undefined))).toBeUndefined();
    expect(
      trace.getSpanContext(extractTraceContext({ traceContext: { traceparent: 'garbage' } })),
    ).toBeUndefined();
  });
});

describe('withProducerSpan / withConsumerSpan', () => {
  it('continues the trace by default and links the consumer to the producer', async () => {
    let data: ReturnType<typeof injectTraceContext<{ orderId: string }>> | undefined;

    await tracer.startActiveSpan('POST /orders', async (request) => {
      await withProducerSpan(tracer, { queue: 'orders', jobName: 'order.process' }, (span) => {
        data = injectTraceContext({ orderId: 'o-1' });
        span.setAttribute('messaging.message.id', '42');
        return Promise.resolve();
      });
      request.end();
    });

    // The consumer runs in a different process in reality; here it is at least a different context.
    await context.with(context.active(), () =>
      withConsumerSpan(
        tracer,
        {
          queue: 'orders',
          jobName: 'order.process',
          jobId: '42',
          attempt: 1,
          enqueuedAt: Date.now() - 5,
          data,
        },
        () => {
          tracer.startActiveSpan('GET /internal/pricing', (span) => {
            span.end();
          });
          return Promise.resolve();
        },
      ),
    );

    const request = spanNamed('POST /orders');
    const producer = spanNamed('orders send');
    const consumer = spanNamed('orders process');
    const pricing = spanNamed('GET /internal/pricing');

    const traceId = request.spanContext().traceId;
    expect([producer, consumer, pricing].map((span) => span.spanContext().traceId)).toEqual([
      traceId,
      traceId,
      traceId,
    ]);

    expect(producer.kind).toBe(SpanKind.PRODUCER);
    expect(producer.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
    expect(producer.attributes['messaging.message.id']).toBe('42');

    expect(consumer.kind).toBe(SpanKind.CONSUMER);
    expect(consumer.parentSpanContext?.spanId).toBe(producer.spanContext().spanId);
    expect(consumer.links).toHaveLength(1);
    expect(consumer.links[0]?.context.spanId).toBe(producer.spanContext().spanId);
    expect(consumer.attributes).toMatchObject({
      'messaging.system': 'bullmq',
      'messaging.operation.type': 'process',
      'messaging.destination.name': 'orders',
      'messaging.message.id': '42',
      'messaging.bullmq.job.attempt': 1,
    });
    expect(consumer.attributes['messaging.bullmq.job.wait_ms']).toBeGreaterThanOrEqual(5);

    expect(pricing.parentSpanContext?.spanId).toBe(consumer.spanContext().spanId);
  });

  it('starts a new trace with only a link when continueTrace is false', async () => {
    let data: ReturnType<typeof injectTraceContext<{ orderId: string }>> | undefined;
    await withProducerSpan(tracer, { queue: 'orders', jobName: 'order.process' }, () => {
      data = injectTraceContext({ orderId: 'o-2' });
      return Promise.resolve();
    });

    await withConsumerSpan(
      tracer,
      { queue: 'orders', jobName: 'order.process', data },
      () => Promise.resolve(),
      { continueTrace: false },
    );

    const producer = spanNamed('orders send');
    const consumer = spanNamed('orders process');
    expect(consumer.spanContext().traceId).not.toBe(producer.spanContext().traceId);
    expect(consumer.parentSpanContext).toBeUndefined();
    expect(consumer.links[0]?.context).toMatchObject({
      traceId: producer.spanContext().traceId,
      spanId: producer.spanContext().spanId,
    });
  });

  it('starts a fresh trace, without links, for a job that carries no context', async () => {
    await withConsumerSpan(
      tracer,
      { queue: 'orders', jobName: 'order.process', data: { orderId: 'x' } },
      () => Promise.resolve(),
    );
    const consumer = spanNamed('orders process');
    expect(consumer.parentSpanContext).toBeUndefined();
    expect(consumer.links).toHaveLength(0);
  });

  it('records a failure on the consumer span and rethrows for the queue to retry', async () => {
    const failure = new Error('pricing unavailable');
    await expect(
      withConsumerSpan(tracer, { queue: 'orders', jobName: 'order.process', data: undefined }, () =>
        Promise.reject(failure),
      ),
    ).rejects.toBe(failure);

    const consumer = spanNamed('orders process');
    expect(consumer.status).toEqual({ code: SpanStatusCode.ERROR, message: 'pricing unavailable' });
    expect(consumer.events.map((event) => event.name)).toContain('exception');
  });

  it('records a failure on the producer span too', async () => {
    await expect(
      withProducerSpan(tracer, { queue: 'orders', jobName: 'order.process' }, () =>
        Promise.reject(new Error('redis down')),
      ),
    ).rejects.toThrow('redis down');
    expect(spanNamed('orders send').status.code).toBe(SpanStatusCode.ERROR);
  });
});
