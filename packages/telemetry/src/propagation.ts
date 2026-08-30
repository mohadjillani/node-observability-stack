import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Link,
  type Span,
  type Tracer,
} from '@opentelemetry/api';

/** W3C trace context as stored in job data. */
export interface TraceCarrier {
  readonly traceparent?: string;
  readonly tracestate?: string;
}

/** Job data that may carry a trace context. */
export interface WithTraceContext {
  readonly traceContext?: TraceCarrier;
}

export const MESSAGING_SYSTEM = 'bullmq';

/**
 * Returns a copy of `data` with the active trace context stored under
 * `traceContext`, using the globally configured propagator (W3C
 * `traceparent`/`tracestate` by default). BullMQ serialises job data as JSON,
 * so the carrier is a plain object, exactly as it would be an HTTP header
 * map for a request.
 */
export function injectTraceContext<T extends object>(
  data: T,
  ctx: Context = context.active(),
): T & { traceContext: TraceCarrier } {
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  return { ...data, traceContext: carrier };
}

/**
 * Rebuilds a context from job data written by `injectTraceContext`. A job
 * without a carrier (enqueued by an uninstrumented producer, or by hand)
 * yields a context with no span, and the consumer starts a new trace.
 */
export function extractTraceContext(data: object | null | undefined): Context {
  const carrier = readCarrier(data);
  if (!carrier) return ROOT_CONTEXT;
  return propagation.extract(ROOT_CONTEXT, carrier);
}

/** Job data comes back from Redis as whatever was stored; trust nothing about its shape. */
function readCarrier(data: object | null | undefined): Record<string, string> | undefined {
  if (!data) return undefined;
  const value: unknown = (data as WithTraceContext).traceContext;
  if (!value || typeof value !== 'object') return undefined;
  const carrier: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') carrier[key] = entry;
  }
  return carrier;
}

export interface ProducerOperation {
  readonly queue: string;
  readonly jobName: string;
}

/**
 * Runs `fn` inside a PRODUCER span for enqueueing a job. Inject the context
 * inside `fn` (`injectTraceContext(data)`) so the job carries this span's
 * ids, then set `messaging.message.id` on the span once the job id is known.
 */
export async function withProducerSpan<T>(
  tracer: Tracer,
  operation: ProducerOperation,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    `${operation.queue} send`,
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        'messaging.system': MESSAGING_SYSTEM,
        'messaging.operation.type': 'send',
        'messaging.destination.name': operation.queue,
        'messaging.bullmq.job.name': operation.jobName,
      },
    },
    async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        recordFailure(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export interface ConsumerOperation {
  readonly queue: string;
  readonly jobName: string;
  readonly jobId?: string | undefined;
  readonly attempt?: number | undefined;
  /** Epoch milliseconds when the job was enqueued; recorded as queue wait time. */
  readonly enqueuedAt?: number | undefined;
  /** The job's data, as stored; only `traceContext` is read from it. */
  readonly data: object | null | undefined;
}

export interface ConsumerOptions {
  /**
   * `true` (default): the consumer span continues the producer's trace, so
   * one trace id covers request → queue → worker. `false`: the consumer
   * starts its own trace and keeps only a link back to the producer — the
   * right shape for batch consumers, or when a job can sit in the queue for
   * hours and a single trace stops being a useful unit.
   */
  readonly continueTrace?: boolean;
}

/**
 * Runs `fn` inside a CONSUMER span for processing a job. The span always
 * links to the producer span found in the job data; whether it also
 * continues that trace is `options.continueTrace`. Errors thrown by `fn` are
 * recorded on the span and rethrown so the queue library's retry logic sees
 * them unchanged.
 */
export async function withConsumerSpan<T>(
  tracer: Tracer,
  operation: ConsumerOperation,
  fn: (span: Span) => Promise<T>,
  options: ConsumerOptions = {},
): Promise<T> {
  const producerContext = extractTraceContext(operation.data);
  const producerSpanContext = trace.getSpanContext(producerContext);
  const links: Link[] = producerSpanContext
    ? [{ context: producerSpanContext, attributes: { 'messaging.operation.type': 'send' } }]
    : [];

  const continueTrace = options.continueTrace ?? true;
  const parent = continueTrace ? producerContext : trace.deleteSpan(context.active());

  const attributes: Attributes = {
    'messaging.system': MESSAGING_SYSTEM,
    'messaging.operation.type': 'process',
    'messaging.destination.name': operation.queue,
    'messaging.bullmq.job.name': operation.jobName,
  };
  if (operation.jobId !== undefined) attributes['messaging.message.id'] = operation.jobId;
  if (operation.attempt !== undefined)
    attributes['messaging.bullmq.job.attempt'] = operation.attempt;
  if (operation.enqueuedAt !== undefined) {
    attributes['messaging.bullmq.job.wait_ms'] = Math.max(0, Date.now() - operation.enqueuedAt);
  }

  const span = tracer.startSpan(
    `${operation.queue} process`,
    { kind: SpanKind.CONSUMER, links, attributes },
    parent,
  );

  return context.with(trace.setSpan(parent, span), async () => {
    try {
      return await fn(span);
    } catch (error) {
      recordFailure(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

function recordFailure(span: Span, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error) span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}
