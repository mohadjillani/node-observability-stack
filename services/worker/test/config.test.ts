import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults around the one required value', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://x' });
    expect(config).toMatchObject({
      QUEUE_NAME: 'orders',
      API_URL: 'http://127.0.0.1:3000',
      WORKER_CONCURRENCY: 5,
      WORKER_METRICS_PORT: 9464,
    });
  });

  it('lists every problem at once', () => {
    const attempt = () => loadConfig({ WORKER_CONCURRENCY: '0', LOG_LEVEL: 'loud' });
    expect(attempt).toThrow(/DATABASE_URL/);
    expect(attempt).toThrow(/WORKER_CONCURRENCY/);
    expect(attempt).toThrow(/LOG_LEVEL/);
  });
});
