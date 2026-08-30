export interface Quote {
  readonly sku: string;
  readonly quantity: number;
  readonly unitCents: number;
  readonly totalCents: number;
}

export interface PricingClient {
  quote(sku: string, quantity: number): Promise<Quote>;
}

export class PricingRequestError extends Error {
  constructor(readonly status: number) {
    super(`pricing request failed with ${String(status)}`);
    this.name = 'PricingRequestError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Calls back into the api. `fetch` is undici, which the SDK instruments
 * through diagnostics channels: the call becomes a client span and the
 * `traceparent` header is added without this module knowing about it.
 */
export function createPricingClient(apiUrl: string, fetchFn: FetchLike = fetch): PricingClient {
  const base = apiUrl.replace(/\/$/, '');
  return {
    async quote(sku, quantity) {
      const url = `${base}/internal/pricing?${new URLSearchParams({ sku, quantity: String(quantity) }).toString()}`;
      const response = await fetchFn(url, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new PricingRequestError(response.status);
      return (await response.json()) as Quote;
    },
  };
}
