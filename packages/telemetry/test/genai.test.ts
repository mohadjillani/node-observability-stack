import { context, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GEN_AI, withModelSpan, type ModelCallObservation } from '../src/genai.js';
import { createMetrics } from '../src/metrics.js';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  provider.register();
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});
beforeEach(() => {
  exporter.reset();
});

const call = { operation: 'chat', provider: 'openai', requestModel: 'gpt-4o-mini' } as const;

describe('withModelSpan', () => {
  it('names the span "{operation} {model}" and sets the conventions', async () => {
    const observations: ModelCallObservation[] = [];

    const answer = await withModelSpan(
      { ...call, onObservation: (observation) => observations.push(observation) },
      (report) => {
        report({ inputTokens: 120, outputTokens: 40, responseModel: 'gpt-4o-mini-2024-07-18' });
        return Promise.resolve('hello');
      },
    );

    expect(answer).toBe('hello');
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('chat gpt-4o-mini');
    expect(span?.attributes[GEN_AI.OPERATION_NAME]).toBe('chat');
    expect(span?.attributes[GEN_AI.PROVIDER_NAME]).toBe('openai');
    expect(span?.attributes[GEN_AI.REQUEST_MODEL]).toBe('gpt-4o-mini');
    expect(span?.attributes[GEN_AI.RESPONSE_MODEL]).toBe('gpt-4o-mini-2024-07-18');
    expect(span?.attributes[GEN_AI.INPUT_TOKENS]).toBe(120);
    expect(span?.attributes[GEN_AI.OUTPUT_TOKENS]).toBe(40);
    expect(observations).toHaveLength(1);
  });

  it('records a failed call with an error type and no tokens', async () => {
    const observations: ModelCallObservation[] = [];

    await expect(
      withModelSpan({ ...call, onObservation: (o) => observations.push(o) }, () => {
        throw new TypeError('provider exploded');
      }),
    ).rejects.toThrow('provider exploded');

    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes['error.type']).toBe('TypeError');
    expect(observations[0]?.errorType).toBe('TypeError');
    expect(observations[0]?.inputTokens).toBe(0);
  });

  it('never records prompt or completion text', async () => {
    await withModelSpan(call, (report) => {
      report({ inputTokens: 1, outputTokens: 1 });
      return Promise.resolve('a secret the model was told');
    });

    const [span] = exporter.getFinishedSpans();
    const serialised = JSON.stringify(span?.attributes);
    expect(serialised).not.toContain('secret');
  });
});

describe('model call metrics', () => {
  const prices = { 'gpt-4o-mini': { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 } };

  const observation = (over: Partial<ModelCallObservation> = {}): ModelCallObservation => ({
    ...call,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    durationSeconds: 0.5,
    ...over,
  });

  it('splits tokens by type and derives cost from the price list', async () => {
    const metrics = createMetrics({
      service: 'test',
      defaultMetrics: false,
      modelPrices: prices,
    });

    metrics.observeModelCall(observation());
    const rendered = await metrics.render();

    expect(rendered).toContain('gen_ai_client_token_usage_count{');
    expect(rendered).toMatch(/model_cost_usd_total\{[^}]*gen_ai_token_type="input"[^}]*\} 0\.15/);
    expect(rendered).toMatch(/model_cost_usd_total\{[^}]*gen_ai_token_type="output"[^}]*\} 0\.6/);
  });

  it('records tokens without a cost for a model missing from the price list', async () => {
    const metrics = createMetrics({ service: 'test', defaultMetrics: false, modelPrices: prices });

    metrics.observeModelCall(observation({ requestModel: 'some-new-model' }));
    const rendered = await metrics.render();

    // A missing price is visible as an absent series rather than as an
    // undercount folded into a total someone is about to trust.
    expect(rendered).toContain('some-new-model');
    expect(rendered).not.toMatch(/model_cost_usd_total\{[^}]*some-new-model/);
  });

  it('counts a failed call in the duration histogram but not the token one', async () => {
    const metrics = createMetrics({ service: 'test', defaultMetrics: false, modelPrices: prices });

    metrics.observeModelCall(
      observation({ errorType: 'RateLimitError', inputTokens: 0, outputTokens: 0 }),
    );
    const rendered = await metrics.render();

    expect(rendered).toMatch(/gen_ai_client_operation_duration_seconds_count\{[^}]*RateLimitError/);
    expect(rendered).not.toContain('gen_ai_client_token_usage_count{');
  });
});
