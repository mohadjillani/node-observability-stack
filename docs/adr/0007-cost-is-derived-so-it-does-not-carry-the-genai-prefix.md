# ADR 0007: Cost is derived, so it does not carry the `gen_ai` prefix

**Status:** accepted · **Date:** 2026-09-17

## Context

Instrumenting a model call produces three numbers a service wants on a
dashboard: how long it took, how many tokens it used, and what it cost.

The OpenTelemetry GenAI semantic conventions define the first two —
`gen_ai.client.operation.duration` and `gen_ai.client.token.usage`, with
attributes `gen_ai.operation.name`, `gen_ai.provider.name`,
`gen_ai.request.model` and `gen_ai.token.type`. They define nothing for
cost.

That absence is not an oversight. A provider reports tokens; it does not
report what those tokens cost _this_ account. The price depends on a
contract — negotiated rates, committed-use discounts, cache-read
pricing, free tiers — that the client knows and the API response does
not carry.

The conventions are also, at the time of writing, marked **Development**:
they live in their own repository, separate from the main semantic
conventions, and have already renamed `gen_ai.system` to
`gen_ai.provider.name`.

## Decision

Emit the two conventional metrics under their conventional names, with
the conventions' recommended bucket boundaries, and emit cost as a third
series called **`model_cost_usd_total`** — deliberately without the
`gen_ai` prefix.

The attribute names are spelled out as constants in
`packages/telemetry/src/genai.ts` rather than imported, because the
published semantic-conventions package does not export stable constants
for attributes at Development stability. One file changes when they
rename something again.

Prices are configuration (`modelPrices` on `createMetrics`), held by the
service that pays the bill. A model absent from the price list records
tokens and no cost.

## Consequences

A reader who knows the conventions can tell at a glance which series are
portable and which are ours. Anything prefixed `gen_ai` means the same
thing in any service that follows the spec; `model_cost_usd_total` is a
local claim that depends on a price list, and its name says so.

**A missing price is visible rather than silent.** The alternative —
defaulting an unknown model to zero — produces a cost total that is
confidently wrong, which is worse than one that is obviously incomplete.
The token series is still there, so the gap is a flat cost line next to
a rising token line.

**The price list goes stale.** Nothing here reconciles it against an
invoice, so this measures what the configured rates say the calls should
have cost, not what was billed. That is a genuine limit, and it is why
the metric is named for the model rather than for the bill.

**A failed call records duration but no tokens.** Observing zeros would
put a sample in the bottom bucket of the token histogram for every
failure and drag the percentiles towards nothing. The call is still
counted, with `error.type`, on the duration histogram.

**Prompt and completion text are never recorded**, on spans or anywhere
else. The conventions do describe opt-in content capture; this stack does
not implement it. It is the highest-volume, highest-risk payload a
service handles, and a span is the wrong place for it.
