import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export interface TelemetryOptions {
  /** Defaults to `OTEL_SERVICE_NAME`, then `unknown_service`. */
  readonly serviceName?: string;
  /** Defaults to `SERVICE_VERSION`, then `0.0.0`. */
  readonly serviceVersion?: string;
  /** Defaults to `DEPLOYMENT_ENVIRONMENT`, then `local`. */
  readonly environment?: string;
  /** OTLP/HTTP base URL of the Collector. Defaults to `OTEL_EXPORTER_OTLP_ENDPOINT`, then `http://localhost:4318`. */
  readonly endpoint?: string;
  /** Replace the OTLP exporter, e.g. with an in-memory exporter in tests. */
  readonly spanProcessors?: readonly SpanProcessor[];
  /** Paths whose incoming requests are never traced (probes and the scrape endpoint). */
  readonly ignorePaths?: readonly string[];
}

export interface Telemetry {
  readonly serviceName: string;
  readonly enabled: boolean;
  /** Flushes pending spans and stops the SDK. Safe to call more than once. */
  shutdown(): Promise<void>;
}

const DEFAULT_IGNORED_PATHS = ['/healthz', '/readyz', '/metrics'];

let active: Telemetry | undefined;

/**
 * Starts the OpenTelemetry SDK for this process.
 *
 * Traces go to the Collector over OTLP/HTTP with the SDK's bounded batch
 * queue in between, so a Collector outage costs dropped spans, never blocked
 * requests. Metrics deliberately do not go through the SDK: the JS metrics
 * SDK does not record exemplars, so RED metrics use prom-client (see
 * `metrics.ts`) and are scraped. Logs go to stdout and are collected there.
 *
 * Call this before the application modules are imported — the instrumentation
 * patches `http`, `express`, `pg` and `ioredis` as they load. `register.ts`
 * does that through `node --import`.
 */
export function startTelemetry(options: TelemetryOptions = {}): Telemetry {
  if (active) return active;

  const serviceName = options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'unknown_service';

  if (isDisabledByEnv()) {
    active = { serviceName, enabled: false, shutdown: () => Promise.resolve() };
    return active;
  }

  if (process.env.OTEL_LOG_LEVEL === undefined) {
    // The SDK's own diagnostics: warnings only, so a Collector outage is
    // visible in the service log without tracing every export.
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  }

  const endpoint = (
    options.endpoint ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    'http://localhost:4318'
  ).replace(/\/$/, '');
  const ignored = new Set(options.ignorePaths ?? DEFAULT_IGNORED_PATHS);

  const spanProcessors = options.spanProcessors
    ? [...options.spanProcessors]
    : [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }))];

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? process.env.SERVICE_VERSION ?? '0.0.0',
      'deployment.environment.name':
        options.environment ?? process.env.DEPLOYMENT_ENVIRONMENT ?? 'local',
    }),
    spanProcessors,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Each of these produces a span per syscall-level operation and adds
        // nothing to the story a trace tells here.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        // Logs are correlated by the pino mixin (logger.ts) and shipped from
        // stdout; the pino instrumentation would send a second copy over OTLP.
        '@opentelemetry/instrumentation-pino': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (request) => {
            const path = request.url?.split('?')[0] ?? '';
            return ignored.has(path);
          },
        },
        '@opentelemetry/instrumentation-express': {
          // Keep router and handler spans (they name the route template);
          // drop the per-middleware spans, which are noise on every request.
          ignoreLayersType: [ExpressLayerType.MIDDLEWARE],
        },
      }),
    ],
  });

  sdk.start();

  let stopping: Promise<void> | undefined;
  active = {
    serviceName,
    enabled: true,
    shutdown: () => {
      stopping ??= sdk.shutdown().catch((error: unknown) => {
        diag.warn('telemetry shutdown failed', error);
      });
      return stopping;
    },
  };
  return active;
}

/** The telemetry started for this process, if any. */
export function getTelemetry(): Telemetry | undefined {
  return active;
}

/** Flushes and stops the SDK started by `startTelemetry`; a no-op otherwise. */
export async function shutdownTelemetry(): Promise<void> {
  const current = active;
  active = undefined;
  await current?.shutdown();
}

function isDisabledByEnv(): boolean {
  return (process.env.OTEL_SDK_DISABLED ?? '').trim().toLowerCase() === 'true';
}
