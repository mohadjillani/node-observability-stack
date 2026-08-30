/**
 * Thin clients for the backends' HTTP APIs, as the e2e suite uses them.
 * Every function polls: telemetry is asynchronous end to end (batch
 * export, tail-sampling decision wait, Tempo ingest, Alloy tail, scrape
 * interval), so "not there yet" is normal for a few seconds.
 */
export const urls = {
  api: process.env.API_URL ?? 'http://localhost:3000',
  tempo: process.env.TEMPO_URL ?? 'http://localhost:3200',
  loki: process.env.LOKI_URL ?? 'http://localhost:3100',
  prometheus: process.env.PROMETHEUS_URL ?? 'http://localhost:9090',
  grafana: process.env.GRAFANA_URL ?? 'http://localhost:3001',
};

export async function pollUntil<T>(
  what: string,
  attempt: () => Promise<T | undefined>,
  timeoutMs = 60_000,
  intervalMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const result = await attempt();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      const cause = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new Error(`timed out waiting for ${what}${cause}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → ${String(response.status)}`);
  return (await response.json()) as T;
}

// ---- api ------------------------------------------------------------------

export async function createOrder(sku: string, quantity = 1): Promise<string> {
  const response = await fetch(`${urls.api}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku, quantity }),
  });
  if (response.status !== 202) throw new Error(`POST /orders → ${String(response.status)}`);
  return ((await response.json()) as { id: string }).id;
}

export function waitForOrderStatus(id: string, status: string): Promise<string> {
  return pollUntil(`order ${id} to be ${status}`, async () => {
    const order = await getJson<{ status: string }>(`${urls.api}/orders/${id}`);
    return order.status === status ? order.status : undefined;
  });
}

// ---- loki -----------------------------------------------------------------

export interface LogLine extends Record<string, unknown> {
  service?: string;
  msg?: string;
  trace_id?: string;
  span_id?: string;
}

/** Runs a LogQL query over the last 15 minutes and returns the parsed JSON lines. */
export async function queryLoki(logql: string): Promise<LogLine[]> {
  const end = Date.now() * 1_000_000;
  const start = end - 15 * 60 * 1_000_000_000;
  const params = new URLSearchParams({
    query: logql,
    start: String(start),
    end: String(end),
    limit: '500',
  });
  const body = await getJson<{ data: { result: { values: [string, string][] }[] } }>(
    `${urls.loki}/loki/api/v1/query_range?${params.toString()}`,
  );
  const lines: LogLine[] = [];
  for (const stream of body.data.result) {
    for (const [, line] of stream.values) {
      try {
        lines.push(JSON.parse(line) as LogLine);
      } catch {
        lines.push({ msg: line });
      }
    }
  }
  return lines;
}

// ---- tempo ----------------------------------------------------------------

export interface TempoSpan {
  service: string;
  name: string;
  kind: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  attributes: Record<string, unknown>;
  links: { traceId: string; spanId: string }[];
  status: string | undefined;
}

interface AnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}
interface KeyValue {
  key: string;
  value?: AnyValue;
}
interface TempoTrace {
  batches?: {
    resource?: { attributes?: KeyValue[] };
    scopeSpans?: {
      spans?: {
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        name: string;
        kind?: string | number;
        attributes?: KeyValue[];
        links?: { traceId: string; spanId: string }[];
        status?: { code?: string | number };
      }[];
    }[];
  }[];
}

/** Tempo returns ids as base64 (protobuf JSON) or hex depending on the endpoint; normalise to hex. */
function toHex(id: string): string {
  return /^[0-9a-f]+$/i.test(id) && (id.length === 32 || id.length === 16)
    ? id.toLowerCase()
    : Buffer.from(id, 'base64').toString('hex');
}

const KINDS: Record<number, string> = {
  1: 'SPAN_KIND_INTERNAL',
  2: 'SPAN_KIND_SERVER',
  3: 'SPAN_KIND_CLIENT',
  4: 'SPAN_KIND_PRODUCER',
  5: 'SPAN_KIND_CONSUMER',
};

function toValue(value: AnyValue | undefined): unknown {
  if (!value) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  return undefined;
}

function toAttributes(list: KeyValue[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key, value } of list ?? []) out[key] = toValue(value);
  return out;
}

/** Fetches a trace by id and flattens it; undefined until Tempo has it. */
export async function getTrace(traceId: string): Promise<TempoSpan[] | undefined> {
  const response = await fetch(`${urls.tempo}/api/traces/${traceId}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`tempo → ${String(response.status)}`);
  const trace = (await response.json()) as TempoTrace;
  const spans: TempoSpan[] = [];
  for (const batch of trace.batches ?? []) {
    const resource = toAttributes(batch.resource?.attributes);
    const serviceName = resource['service.name'];
    const service = typeof serviceName === 'string' ? serviceName : 'unknown';
    for (const scope of batch.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        spans.push({
          service,
          name: span.name,
          kind:
            typeof span.kind === 'number'
              ? (KINDS[span.kind] ?? String(span.kind))
              : (span.kind ?? ''),
          traceId: toHex(span.traceId),
          spanId: toHex(span.spanId),
          parentSpanId: span.parentSpanId ? toHex(span.parentSpanId) : undefined,
          attributes: toAttributes(span.attributes),
          links: (span.links ?? []).map((link) => ({
            traceId: toHex(link.traceId),
            spanId: toHex(link.spanId),
          })),
          status: span.status?.code === undefined ? undefined : String(span.status.code),
        });
      }
    }
  }
  return spans.length > 0 ? spans : undefined;
}

/** TraceQL search; returns trace ids. */
export async function searchTraces(traceql: string, limit = 20): Promise<string[]> {
  const end = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({
    q: traceql,
    limit: String(limit),
    start: String(end - 900),
    end: String(end),
  });
  const body = await getJson<{ traces?: { traceID: string }[] }>(
    `${urls.tempo}/api/search?${params.toString()}`,
  );
  return (body.traces ?? []).map((trace) => trace.traceID);
}

// ---- prometheus -----------------------------------------------------------

export async function queryPrometheus(
  promql: string,
): Promise<{ metric: Record<string, string>; value: number }[]> {
  const params = new URLSearchParams({ query: promql });
  const body = await getJson<{
    data: { result: { metric: Record<string, string>; value: [number, string] }[] };
  }>(`${urls.prometheus}/api/v1/query?${params.toString()}`);
  return body.data.result.map((row) => ({ metric: row.metric, value: Number(row.value[1]) }));
}

export async function queryExemplars(
  selector: string,
): Promise<{ traceId: string; value: number }[]> {
  const end = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({
    query: selector,
    start: String(end - 900),
    end: String(end),
  });
  const body = await getJson<{
    data: { exemplars: { labels: Record<string, string>; value: string }[] }[];
  }>(`${urls.prometheus}/api/v1/query_exemplars?${params.toString()}`);
  const out: { traceId: string; value: number }[] = [];
  for (const series of body.data) {
    for (const exemplar of series.exemplars) {
      const traceId = exemplar.labels.trace_id;
      if (traceId) out.push({ traceId, value: Number(exemplar.value) });
    }
  }
  return out;
}

export async function labelValues(label: string): Promise<string[]> {
  const body = await getJson<{ data: string[] }>(`${urls.prometheus}/api/v1/label/${label}/values`);
  return body.data;
}

export async function alertRuleNames(): Promise<string[]> {
  const body = await getJson<{ data: { groups: { rules: { name: string }[] }[] } }>(
    `${urls.prometheus}/api/v1/rules?type=alert`,
  );
  return body.data.groups.flatMap((group) => group.rules.map((rule) => rule.name));
}

// ---- grafana --------------------------------------------------------------

export function grafanaJson<T>(path: string): Promise<T> {
  return getJson<T>(`${urls.grafana}${path}`);
}
