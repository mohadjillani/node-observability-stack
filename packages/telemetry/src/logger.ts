import { isSpanContextValid, trace, TraceFlags } from '@opentelemetry/api';
import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

export interface TraceFields {
  readonly trace_id: string;
  readonly span_id: string;
  readonly trace_flags: string;
}

export interface CreateLoggerOptions {
  /** Appears as `service` on every line; use the same value as the OTel service name. */
  readonly service: string;
  readonly level?: string;
  /** Where lines go. Defaults to stdout; tests pass a sink. */
  readonly destination?: DestinationStream;
  /** Extra fields stamped on every line. */
  readonly base?: Record<string, unknown>;
}

/**
 * The trace and span ids of the active span, in the field names Grafana's
 * Loki → Tempo link expects. Empty when there is no active span (startup,
 * shutdown, timers), so callers can spread it into any log call.
 */
export function traceFields(): TraceFields | Record<string, never> {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext || !isSpanContextValid(spanContext)) return {};
  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    trace_flags: isSampled(spanContext.traceFlags) ? '01' : '00',
  };
}

function isSampled(flags: number): boolean {
  return (flags & TraceFlags.SAMPLED) !== 0;
}

/**
 * A pino logger whose every line carries `trace_id` and `span_id` when one
 * is active. The ids come from the OpenTelemetry context, which is the same
 * place the exporter reads them, so a log line and its trace cannot
 * disagree. The mixin runs per call; nothing has to be passed around.
 */
/**
 * Waits for buffered lines to reach the destination. pino writes to a pipe
 * asynchronously, so a `process.exit()` right after the last log call can
 * drop it; call this first.
 */
export function flushLogger(logger: Logger): Promise<void> {
  return new Promise((resolve) => {
    logger.flush(() => {
      resolve();
    });
  });
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const loggerOptions: LoggerOptions = {
    level: options.level ?? 'info',
    base: { service: options.service, ...options.base },
    // Loki's level detection and humans both prefer `"level":"info"` to 30.
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin: traceFields,
  };
  return options.destination ? pino(loggerOptions, options.destination) : pino(loggerOptions);
}
