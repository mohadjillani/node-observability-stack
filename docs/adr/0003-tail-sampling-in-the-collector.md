# ADR 0003: Tail sampling in the Collector, not head sampling in the SDK

**Status:** accepted · **Date:** 2026-08-30

## Context

Keeping every trace is not an option at any real volume; something has
to decide. The SDK can decide at the root span (head sampling:
`OTEL_TRACES_SAMPLER=parentbased_traceidratio`), before the request has
done anything. The Collector can decide after the trace is complete
(tail sampling), with the outcome in hand.

## Decision

The SDK samples nothing out (`parentbased_always_on`, the default) and
the Collector's `tail_sampling` processor keeps:

- every trace with an `ERROR` status span or a 5xx response code,
- every trace over 500 ms end to end,
- 20% of the rest.

Policies, `decision_wait`, memory and topology are documented in
[`docs/sampling.md`](../sampling.md); this record is about the choice.

The argument is short: the traces anyone opens after the fact are the
failed and the slow ones, and head sampling throws away 80–99% of exactly
those. Tail sampling keeps all of them at a fraction of the total volume,
and the 20% baseline shows what normal looks like next to them.

## Consequences

- Every span is created and exported, so the application pays the full
  instrumentation cost regardless of what is kept. `docs/overhead.md` is
  how that cost is measured.
- The Collector holds traces in memory for `decision_wait`. Its
  `memory_limiter` is the safety valve; the SDK's bounded exporter queue
  is the second one.
- All spans of a trace must reach the same Collector. Trivial with one;
  a trace-id-aware load balancer with more.
- Spans arriving after the decision are judged alone. `decision_wait`
  must exceed the longest trace worth keeping whole, and long-running
  jobs should be link-only traces of their own (ADR 0002).
- An exemplar can point at a trace that was dropped. The e2e test
  tolerates it; the exemplars that matter — on slow buckets and error
  series — always resolve.
- The 500 ms latency policy is deliberately the same number as the p95
  alert, so an alert always has traces behind it.
- The trigger for revisiting: export volume becoming the bottleneck
  before storage does. Then a small head-sampling ratio in the SDK in
  front of tail sampling trades a known percentage of errors for
  bandwidth.
