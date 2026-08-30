import { createServer, type Server } from 'node:http';

/** One span as the OTLP/HTTP JSON encoding delivers it, flattened with its resource. */
export interface ReceivedSpan {
  readonly service: string;
  readonly scope: string;
  readonly name: string;
  readonly kind: number;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly attributes: Record<string, unknown>;
  readonly links: readonly { traceId: string; spanId: string }[];
  readonly status: { code?: number; message?: string } | undefined;
}

interface AnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: AnyValue[] };
}
interface KeyValue {
  key: string;
  value?: AnyValue;
}
interface ExportTraceServiceRequest {
  resourceSpans?: {
    resource?: { attributes?: KeyValue[] };
    scopeSpans?: {
      scope?: { name?: string };
      spans?: {
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        name: string;
        kind?: number;
        attributes?: KeyValue[];
        links?: { traceId: string; spanId: string }[];
        status?: { code?: number; message?: string };
      }[];
    }[];
  }[];
}

export const SpanKind = { INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 } as const;

export interface OtlpReceiver {
  readonly url: string;
  readonly spans: readonly ReceivedSpan[];
  /** Polls until `predicate` is satisfied by the spans received so far. */
  waitFor(
    predicate: (spans: readonly ReceivedSpan[]) => boolean,
    timeoutMs?: number,
  ): Promise<void>;
  close(): Promise<void>;
}

/**
 * A stand-in for the Collector: accepts OTLP/HTTP JSON on /v1/traces and
 * keeps the spans, so a test can assert on exactly what the services export.
 */
export async function startOtlpReceiver(): Promise<OtlpReceiver> {
  const spans: ReceivedSpan[] = [];

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method === 'POST' && request.url === '/v1/traces') {
        const payload = JSON.parse(Buffer.concat(chunks).toString()) as ExportTraceServiceRequest;
        spans.push(...flatten(payload));
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('receiver did not bind');

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    spans,
    async waitFor(predicate, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(spans)) {
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for spans; received ${String(spans.length)}: ${spans
              .map((span) => `${span.service}:${span.name}`)
              .join(', ')}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

function flatten(payload: ExportTraceServiceRequest): ReceivedSpan[] {
  const out: ReceivedSpan[] = [];
  for (const resourceSpans of payload.resourceSpans ?? []) {
    const resource = toAttributes(resourceSpans.resource?.attributes);
    const serviceName = resource['service.name'];
    const service = typeof serviceName === 'string' ? serviceName : 'unknown';
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      for (const span of scopeSpans.spans ?? []) {
        out.push({
          service,
          scope: scopeSpans.scope?.name ?? '',
          name: span.name,
          kind: span.kind ?? 0,
          traceId: span.traceId,
          spanId: span.spanId,
          // Root spans arrive with the field omitted or empty.
          parentSpanId:
            span.parentSpanId === undefined || span.parentSpanId === ''
              ? undefined
              : span.parentSpanId,
          attributes: toAttributes(span.attributes),
          links: (span.links ?? []).map((link) => ({ traceId: link.traceId, spanId: link.spanId })),
          status: span.status,
        });
      }
    }
  }
  return out;
}

function toAttributes(list: KeyValue[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key, value } of list ?? []) out[key] = toValue(value);
  return out;
}

function toValue(value: AnyValue | undefined): unknown {
  if (!value) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(toValue);
  return undefined;
}
