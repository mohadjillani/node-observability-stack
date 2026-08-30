import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),
  QUEUE_NAME: z.string().min(1).default('orders'),
  API_URL: z.string().min(1).default('http://127.0.0.1:3000'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  /** Port of the worker's own HTTP listener for `/metrics` and `/healthz`. */
  WORKER_METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`Invalid environment:\n${lines.join('\n')}`);
}
