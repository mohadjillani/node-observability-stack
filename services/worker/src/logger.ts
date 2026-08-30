import { pino, type Logger } from 'pino';

export type { Logger } from 'pino';

export function createLogger(service: string, level: string): Logger {
  return pino({
    level,
    base: { service },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
