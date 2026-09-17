import { withModelSpan, type Metrics } from '@mohadjillani/telemetry';

export interface Summary {
  readonly note: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface SummariserOptions {
  readonly metrics: Metrics;
  readonly model?: string;
  readonly provider?: string;
  /** Milliseconds per generated token. Default 8. */
  readonly tokenLatencyMs?: number;
}

export class SummaryUnavailableError extends Error {
  constructor(sku: string) {
    super(`summary unavailable for ${sku}`);
    this.name = 'SummaryUnavailableError';
  }
}

// A non-empty tuple, so indexing it modulo the length yields a `string`.
const NOTES: readonly [string, ...string[]] = [
  'standard handling',
  'fragile, pack with care',
  'oversize, palletise',
  'expedite to the front of the queue',
];

/**
 * A stand-in for a model call, so the stack has a GenAI span to observe.
 *
 * Like `pricing`, it is deliberately boring and deterministic — the point of
 * this repository is the telemetry pipeline, not the workload. What it does
 * carry faithfully is the *shape* of a model call: latency proportional to the
 * tokens it produced rather than to the work requested, a token count that is
 * only known once the answer exists, and a `FAIL-` sku that errors so the
 * failure path has something to record.
 */
export function createSummariser(options: SummariserOptions) {
  const { metrics } = options;
  const model = options.model ?? 'demo-small';
  const provider = options.provider ?? 'demo';
  const latency = options.tokenLatencyMs ?? 8;

  return async function summarise(sku: string, quantity: number): Promise<Summary> {
    return withModelSpan(
      {
        operation: 'chat',
        provider,
        requestModel: model,
        onObservation: (observation) => {
          metrics.observeModelCall(observation);
        },
      },
      async (report) => {
        const prompt = `Handling note for ${String(quantity)} x ${sku}`;
        const inputTokens = Math.ceil(prompt.length / 4);

        if (sku.startsWith('FAIL-')) throw new SummaryUnavailableError(sku);

        const note = NOTES[hash(sku) % NOTES.length] ?? NOTES[0];
        const outputTokens = Math.ceil(note.length / 4);
        await new Promise((resolve) => setTimeout(resolve, outputTokens * latency));

        report({ inputTokens, outputTokens, responseModel: model });
        return { note, inputTokens, outputTokens };
      },
    );
  };
}

function hash(value: string): number {
  let h = 2166136261;
  for (const char of value) {
    h ^= char.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}
