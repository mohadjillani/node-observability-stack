import { isSpanContextValid, trace, TraceFlags } from '@opentelemetry/api';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
  type OpenMetricsContentType,
} from 'prom-client';

/**
 * RED metrics for HTTP routes and queue jobs, exposed for scraping in the
 * OpenMetrics format with exemplars.
 *
 * Every histogram observation made inside a sampled span carries that span's
 * `trace_id` as an exemplar, which is what lets Grafana jump from a latency
 * bucket to the trace that landed in it. prom-client is used instead of the
 * OpenTelemetry metrics API because the JS metrics SDK (2.x) does not record
 * exemplars; see docs/adr/0005.
 */

/**
 * A label value that could be an id: a UUID, a numeric path segment
 * (`/orders/123`) or a long hex string. This is what the guard looks for;
 * plain numbers (`status_code="202"`) are fine.
 */
const HIGH_CARDINALITY_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\/\d{2,}(\/|$)|[0-9a-f]{24,}/i;

export function looksHighCardinality(value: string): boolean {
  return HIGH_CARDINALITY_PATTERN.test(value);
}

/** The label value used when a request matched no route (404s, probes off the router). */
export const UNMATCHED_ROUTE = 'unmatched';

export interface RouteAwareRequest {
  readonly method: string;
  readonly baseUrl?: string | undefined;
  readonly route?: { readonly path?: unknown } | undefined;
}

/**
 * The Express route *template* for a matched request — `/orders/:id`, never
 * `/orders/9f1c…`. A request that matched nothing reports `unmatched` rather
 * than its path, so a scanner hitting random URLs cannot mint series.
 */
export function routeTemplate(request: RouteAwareRequest): string {
  const path = request.route?.path;
  if (typeof path !== 'string' || path.length === 0) return UNMATCHED_ROUTE;
  const base = request.baseUrl ?? '';
  const full = `${base}${path}`.replace(/\/{2,}/g, '/');
  return full.length > 1 ? full.replace(/\/$/, '') : full;
}

export interface ExemplarLabels {
  readonly trace_id: string;
  readonly span_id: string;
}

/** Exemplar labels for the active sampled span, or `undefined` outside one. */
export function activeExemplar(): ExemplarLabels | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext || !isSpanContextValid(spanContext)) return undefined;
  if ((spanContext.traceFlags & TraceFlags.SAMPLED) === 0) return undefined;
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}

export interface MetricsOptions {
  /** Stamped on every series as `service`. */
  readonly service: string;
  /** Node runtime metrics (heap, event loop lag, GC). On by default. */
  readonly defaultMetrics?: boolean;
  /** Latency buckets in seconds. */
  readonly httpBuckets?: readonly number[];
  readonly jobBuckets?: readonly number[];
  /** Called on each scrape to report queue depths. */
  readonly queueDepth?: () => Promise<readonly QueueDepth[]>;
  /** Route templates left out of the request histogram; probes and the scrape endpoint by default. */
  readonly ignoreRoutes?: readonly string[];
}

export interface QueueDepth {
  readonly queue: string;
  readonly state: 'waiting' | 'active' | 'delayed' | 'failed' | 'completed';
  readonly count: number;
}

export type JobOutcome = 'completed' | 'failed';

export interface JobObservation {
  readonly queue: string;
  readonly name: string;
  readonly outcome: JobOutcome;
  readonly durationSeconds: number;
}

export interface Metrics {
  readonly registry: Registry<OpenMetricsContentType>;
  readonly contentType: string;
  /** Renders the registry; the result is OpenMetrics text with exemplars. */
  render(): Promise<string>;
  /** Express-compatible middleware recording one observation per response. */
  httpMiddleware(): (
    request: RouteAwareRequest,
    response: { statusCode: number; once(event: 'finish', listener: () => void): unknown },
    next: () => void,
  ) => void;
  /** Express-compatible handler for `GET /metrics`. */
  handler(): (
    request: unknown,
    response: {
      setHeader(name: string, value: string): unknown;
      end(body: string): unknown;
    },
  ) => Promise<void>;
  observeJob(observation: JobObservation): void;
  jobStalled(queue: string): void;
}

const DEFAULT_HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const DEFAULT_IGNORED_ROUTES = ['/metrics', '/healthz', '/readyz'];
const DEFAULT_JOB_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export function createMetrics(options: MetricsOptions): Metrics {
  const registry = new Registry<OpenMetricsContentType>();
  registry.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
  registry.setDefaultLabels({ service: options.service });
  if (options.defaultMetrics ?? true) collectDefaultMetrics({ register: registry });
  const ignoredRoutes = new Set(options.ignoreRoutes ?? DEFAULT_IGNORED_ROUTES);

  const httpDuration = new Histogram({
    name: 'http_server_request_duration_seconds',
    help: 'Duration of HTTP requests by route template, method and status code',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [...(options.httpBuckets ?? DEFAULT_HTTP_BUCKETS)],
    enableExemplars: true,
    registers: [registry],
  });

  const httpInFlight = new Gauge({
    name: 'http_server_active_requests',
    help: 'Requests currently being handled',
    registers: [registry],
  });

  const jobDuration = new Histogram({
    name: 'queue_job_duration_seconds',
    help: 'Duration of processed jobs by queue, job name and outcome',
    labelNames: ['queue', 'name', 'outcome'] as const,
    buckets: [...(options.jobBuckets ?? DEFAULT_JOB_BUCKETS)],
    enableExemplars: true,
    registers: [registry],
  });

  const jobsStalled = new Counter({
    name: 'queue_jobs_stalled_total',
    help: 'Jobs whose lock expired while a worker held them',
    labelNames: ['queue'] as const,
    registers: [registry],
  });

  if (options.queueDepth) {
    const collect = options.queueDepth;
    new Gauge({
      name: 'queue_depth',
      help: 'Jobs in each queue state at scrape time',
      labelNames: ['queue', 'state'] as const,
      registers: [registry],
      async collect() {
        for (const depth of await collect()) {
          this.set({ queue: depth.queue, state: depth.state }, depth.count);
        }
      },
    });
  }

  return {
    registry,
    contentType: registry.contentType,
    render: () => registry.metrics(),

    httpMiddleware() {
      return (request, response, next) => {
        const started = process.hrtime.bigint();
        httpInFlight.inc();
        response.once('finish', () => {
          httpInFlight.dec();
          // The route is only known once the router has run, i.e. now.
          const route = routeTemplate(request);
          if (ignoredRoutes.has(route)) return;
          const seconds = Number(process.hrtime.bigint() - started) / 1e9;
          const labels = {
            method: request.method,
            route,
            status_code: String(response.statusCode),
          };
          httpDuration.observe({ labels, value: seconds, ...exemplarFor(activeExemplar()) });
        });
        next();
      };
    },

    handler() {
      return async (_request, response) => {
        response.setHeader('content-type', registry.contentType);
        response.end(await registry.metrics());
      };
    },

    observeJob(observation) {
      jobDuration.observe({
        labels: { queue: observation.queue, name: observation.name, outcome: observation.outcome },
        value: observation.durationSeconds,
        ...exemplarFor(activeExemplar()),
      });
    },

    jobStalled(queue) {
      jobsStalled.inc({ queue });
    },
  };
}

/**
 * prom-client types exemplar labels as a subset of the series labels, but an
 * exemplar's labels are their own set (`trace_id`, `span_id`); widen them.
 */
function exemplarFor(
  exemplar: ExemplarLabels | undefined,
): { exemplarLabels: Record<string, string> } | Record<string, never> {
  return exemplar ? { exemplarLabels: { ...exemplar } } : {};
}

/**
 * Scans rendered metrics for label values that look like ids or raw paths.
 * Used by the guard test and the e2e suite; returns the offending series.
 */
export function findHighCardinalityLabels(rendered: string): string[] {
  const offenders: string[] = [];
  for (const line of rendered.split('\n')) {
    if (line.startsWith('#') || !line.includes('{')) continue;
    const labels = line.slice(line.indexOf('{') + 1, line.indexOf('}'));
    for (const match of labels.matchAll(/(\w+)="([^"]*)"/g)) {
      const [, name, value] = match;
      if (name === 'trace_id' || name === 'span_id') continue;
      if (value !== undefined && looksHighCardinality(value))
        offenders.push(line.split(' ')[0] ?? line);
    }
  }
  return [...new Set(offenders)];
}
