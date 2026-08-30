import { setTimeout as sleep } from 'node:timers/promises';

export interface Quote {
  readonly sku: string;
  readonly quantity: number;
  readonly unitCents: number;
  readonly totalCents: number;
}

export interface PricingOptions {
  /** Delay applied to `SLOW-*` skus, in milliseconds. */
  readonly slowMs?: number;
}

/** Thrown for `FAIL-*` skus to stand in for a dependency that is down. */
export class PricingUnavailableError extends Error {
  constructor(sku: string) {
    super(`pricing unavailable for ${sku}`);
    this.name = 'PricingUnavailableError';
  }
}

/**
 * A deterministic price per sku, with two prefixes that make the demo
 * misbehave on purpose: `SLOW-` adds latency and `FAIL-` fails. Both are
 * what `scripts/break-it.sh` sends to light up the dashboards and alerts.
 */
export async function quote(
  sku: string,
  quantity: number,
  options: PricingOptions = {},
): Promise<Quote> {
  if (sku.startsWith('FAIL-')) throw new PricingUnavailableError(sku);
  if (sku.startsWith('SLOW-')) await sleep(options.slowMs ?? 1_500);
  const unitCents = 100 + (hash(sku) % 9_900);
  return { sku, quantity, unitCents, totalCents: unitCents * quantity };
}

function hash(value: string): number {
  let h = 2166136261;
  for (const char of value) {
    h ^= char.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}
