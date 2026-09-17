import { SpanKind, SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api';

/**
 * Attribute names from the OpenTelemetry GenAI semantic conventions.
 *
 * Spelled out here rather than imported from `@opentelemetry/semantic-conventions`
 * because these live in a separate repository from the main conventions and
 * are marked **Development**, so the package does not export stable constants
 * for them. Keeping the strings in one place is what makes the rename that
 * will eventually come a single edit — `gen_ai.system` already became
 * `gen_ai.provider.name` once.
 *
 * https://github.com/open-telemetry/semantic-conventions-genai
 */
export const GEN_AI = {
  OPERATION_NAME: 'gen_ai.operation.name',
  PROVIDER_NAME: 'gen_ai.provider.name',
  REQUEST_MODEL: 'gen_ai.request.model',
  RESPONSE_MODEL: 'gen_ai.response.model',
  INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  TOKEN_TYPE: 'gen_ai.token.type',
} as const;

/** `chat`, `embeddings`, `text_completion` — the conventions' operation names. */
export type ModelOperation = 'chat' | 'embeddings' | 'text_completion';

export interface ModelCall {
  readonly operation: ModelOperation;
  /** `openai`, `anthropic`, `gcp.vertex_ai` … */
  readonly provider: string;
  readonly requestModel: string;
}

export interface ModelUsage {
  /** The model that actually answered, when the provider reports one. */
  readonly responseModel?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Called by the wrapped function once the provider has reported usage. */
export type ReportUsage = (usage: ModelUsage) => void;

export interface ModelCallObservation extends ModelCall {
  readonly responseModel?: string | undefined;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationSeconds: number;
  /** Set when the call failed, as the conventions' `error.type`. */
  readonly errorType?: string | undefined;
}

export interface WithModelSpanOptions extends ModelCall {
  readonly tracer?: Tracer;
  /** Receives one observation per call, success or failure. */
  readonly onObservation?: (observation: ModelCallObservation) => void;
}

/**
 * Wraps a model call in a span carrying the GenAI conventions.
 *
 * Usage arrives *after* the call — it is in the last chunk of a stream — so
 * the wrapped function is handed a `report` callback rather than being asked
 * to return the numbers alongside its result. A call that fails before
 * reporting still produces a span and an observation, with zero tokens and an
 * `error.type`, because a provider error that costs nothing is exactly the
 * case a cost dashboard must not silently drop.
 *
 * Prompt and completion text are deliberately never recorded. They are the
 * highest-volume, highest-risk payload a service handles, and a span is the
 * wrong place for either.
 */
export async function withModelSpan<T>(
  options: WithModelSpanOptions,
  fn: (report: ReportUsage) => Promise<T>,
): Promise<T> {
  const tracer = options.tracer ?? trace.getTracer('genai');
  // "{operation} {model}" is the name the conventions specify.
  const name = `${options.operation} ${options.requestModel}`;

  return tracer.startActiveSpan(name, { kind: SpanKind.CLIENT }, async (span: Span) => {
    span.setAttribute(GEN_AI.OPERATION_NAME, options.operation);
    span.setAttribute(GEN_AI.PROVIDER_NAME, options.provider);
    span.setAttribute(GEN_AI.REQUEST_MODEL, options.requestModel);

    const started = process.hrtime.bigint();
    let usage: ModelUsage | undefined;
    const report: ReportUsage = (reported) => {
      usage = reported;
    };

    const observe = (errorType?: string): void => {
      options.onObservation?.({
        operation: options.operation,
        provider: options.provider,
        requestModel: options.requestModel,
        responseModel: usage?.responseModel,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        durationSeconds: Number(process.hrtime.bigint() - started) / 1e9,
        errorType,
      });
    };

    try {
      const result = await fn(report);
      if (usage) {
        if (usage.responseModel) span.setAttribute(GEN_AI.RESPONSE_MODEL, usage.responseModel);
        span.setAttribute(GEN_AI.INPUT_TOKENS, usage.inputTokens);
        span.setAttribute(GEN_AI.OUTPUT_TOKENS, usage.outputTokens);
      }
      observe();
      return result;
    } catch (error) {
      const errorType = error instanceof Error ? error.name : 'unknown';
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
      span.setAttribute('error.type', errorType);
      observe(errorType);
      throw error;
    } finally {
      span.end();
    }
  });
}
