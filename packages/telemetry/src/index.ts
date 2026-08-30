export { startTelemetry, shutdownTelemetry, getTelemetry } from './sdk.js';
export type { Telemetry, TelemetryOptions } from './sdk.js';
export { createLogger, flushLogger, traceFields } from './logger.js';
export type { Logger, CreateLoggerOptions, TraceFields } from './logger.js';
export {
  injectTraceContext,
  extractTraceContext,
  withProducerSpan,
  withConsumerSpan,
  MESSAGING_SYSTEM,
} from './propagation.js';
export type {
  TraceCarrier,
  WithTraceContext,
  ProducerOperation,
  ConsumerOperation,
  ConsumerOptions,
} from './propagation.js';
