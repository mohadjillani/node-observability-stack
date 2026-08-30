import { Writable } from 'node:stream';
import { context, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, traceFields } from '../src/logger.js';

const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
});
const tracer = trace.getTracer('logger-test');

beforeAll(() => {
  provider.register();
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});

function sink() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { lines, stream };
}

describe('createLogger', () => {
  it('stamps the active span ids on every line, and nothing outside a span', () => {
    const { lines, stream } = sink();
    const logger = createLogger({ service: 'api', destination: stream });

    logger.info('no span');

    let expected: { traceId: string; spanId: string } | undefined;
    tracer.startActiveSpan('POST /orders', (span) => {
      expected = { traceId: span.spanContext().traceId, spanId: span.spanContext().spanId };
      logger.info({ orderId: 'o-1' }, 'order created');
      logger.child({ component: 'queue' }).warn('child logger inherits the mixin');
      span.end();
    });

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ level: 'info', service: 'api', msg: 'no span' });
    expect(lines[0]).not.toHaveProperty('trace_id');

    expect(lines[1]).toMatchObject({
      level: 'info',
      service: 'api',
      orderId: 'o-1',
      msg: 'order created',
      trace_id: expected?.traceId,
      span_id: expected?.spanId,
      trace_flags: '01',
    });
    expect(lines[2]).toMatchObject({
      level: 'warn',
      component: 'queue',
      trace_id: expected?.traceId,
      span_id: expected?.spanId,
    });
    expect(typeof lines[1]?.time).toBe('string');
  });

  it('follows the span that is active at the time of each call', () => {
    const { lines, stream } = sink();
    const logger = createLogger({ service: 'worker', destination: stream });
    const seen: string[] = [];

    tracer.startActiveSpan('orders process', (outer) => {
      seen.push(outer.spanContext().spanId);
      logger.info('in outer');
      tracer.startActiveSpan('GET /internal/pricing', (inner) => {
        seen.push(inner.spanContext().spanId);
        logger.info('in inner');
        inner.end();
      });
      logger.info('back in outer');
      outer.end();
    });

    expect(lines.map((line) => line.span_id)).toEqual([seen[0], seen[1], seen[0]]);
    expect(new Set(lines.map((line) => line.trace_id)).size).toBe(1);
  });

  it('exposes the same fields for callers that build their own log objects', () => {
    expect(traceFields()).toEqual({});
    tracer.startActiveSpan('x', (span) => {
      expect(traceFields()).toEqual({
        trace_id: span.spanContext().traceId,
        span_id: span.spanContext().spanId,
        trace_flags: '01',
      });
      span.end();
    });
  });
});
