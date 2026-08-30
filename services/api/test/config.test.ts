import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults around the one required value', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://x' });
    expect(config).toMatchObject({
      PORT: 3000,
      QUEUE_NAME: 'orders',
      LOG_LEVEL: 'info',
      SLOW_PRICING_MS: 1500,
    });
  });

  it('lists every problem at once', () => {
    const attempt = () => loadConfig({ PORT: 'eighty', LOG_LEVEL: 'loud' });
    expect(attempt).toThrow(/DATABASE_URL/);
    expect(attempt).toThrow(/PORT/);
    expect(attempt).toThrow(/LOG_LEVEL/);
  });
});
