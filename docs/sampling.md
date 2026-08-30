# Sampling

Every span the services produce is exported. The decision about what to
keep is made once, in the Collector, after a trace is complete
(`otel/collector.yaml`, `tail_sampling`). This page is the reasoning, the
knobs, and the ways it goes wrong.

## Why tail, not head

Head sampling — the SDK deciding at the root span whether a trace is
recorded — is cheap and simple, and it decides before anything has
happened. At 10% it keeps 10% of the errors and 10% of the slow requests,
which are exactly the traces someone will later want. Its one advantage is
that unsampled traces cost nothing anywhere.

Tail sampling sees the finished trace: status codes, duration, attributes
from every service that took part. It can keep every error and every slow
trace, and a fraction of the rest for a picture of normal. The cost is
that every span is produced, exported and held in Collector memory until
the decision is made.

For a demo with two services the choice is obvious. For a real system the
tradeoff is memory and Collector topology (below) against never again
missing the trace behind an incident. Most teams that can afford one
Collector per environment take the tail.

## The policies

Policies are OR-ed: a trace is kept if any policy accepts it.

| Policy          | Type                | Keeps                                                            |
| --------------- | ------------------- | ---------------------------------------------------------------- |
| `errors`        | `status_code`       | Any trace with a span whose status is `ERROR`                    |
| `slow`          | `latency`           | Any trace whose root-to-last-span duration is > 500 ms           |
| `server-errors` | `numeric_attribute` | Any trace with a span carrying `http.response.status_code` ≥ 500 |
| `baseline`      | `probabilistic`     | 20% of everything else                                           |

`errors` and `server-errors` overlap on purpose: the http instrumentation
marks a 5xx server span as `ERROR`, but a client span that receives a 5xx
is not necessarily an error by semantic-conventions rules. Both are
cheap; keeping both means a 5xx anywhere in the trace is enough.

500 ms matches the `HighLatencyP95` alert threshold (`prometheus/rules/`),
so any trace behind that alert is in Tempo by construction.

20% is a demo number. In production it is set from the retained volume
you can pay for: the errors and slow traces are the fixed cost, the
baseline is the dial.

## `decision_wait`

The Collector holds a trace for `decision_wait` (10 s here) after its
first span arrives, then evaluates the policies over the spans it has and
exports or drops. Spans that arrive later are evaluated as a new trace on
their own, which means:

- A late span from a kept trace is usually kept again (it is judged alone
  against the same policies) and Tempo merges it into the trace.
- A late span from a dropped trace becomes an orphan trace of one span.
- A late span that _is_ the error (a 503 in a job that ran after a long
  backoff) is kept alone; the request-side spans are gone.

So `decision_wait` must exceed the longest trace you expect to see whole.
Here the slowest path is the `SLOW-` pricing sku at 1.5 s, and a failed
job retried three times with exponential backoff from 500 ms spans about
4 s; 10 s has room. A system with minute-long batch jobs needs a different
design: link-only consumer spans (`withConsumerSpan(..., { continueTrace:
false })`) so the job is its own short trace.

## Memory

The processor holds up to `num_traces` traces (50 000) in memory. Rough
budget: spans per trace × bytes per span × traces per `decision_wait`
window. This demo produces ~12 spans per order; at 100 orders/s and a
10 s wait that is 1 000 traces, ~12 000 spans, a few MB. The
`memory_limiter` processor in front of it refuses data before the
Collector is OOM-killed, and the SDK exporters retry, so a burst degrades
to dropped spans rather than a dead pipeline.

## Topology

Tail sampling requires every span of a trace to reach the _same_ Collector
instance. With one Collector (this stack) that is automatic. With several,
put a load-balancing layer in front that routes by trace id — the
`loadbalancing` exporter in a first tier of Collectors, `tail_sampling` in
the second — or accept that traces split across instances are sampled
inconsistently.

## What the SDK does

Nothing. `OTEL_TRACES_SAMPLER` stays at its default,
`parentbased_always_on`, so the Collector sees everything and the
services carry no sampling configuration. If the export volume itself
becomes the problem (network, Collector CPU), a small head-sampling ratio
in the SDK _in addition to_ tail sampling is the pragmatic answer; the
errors you lose are then a known percentage.

## Exemplars and dropped traces

Exemplars are attached to histogram samples at record time, in the
service, before the Collector has decided anything. A sample from a fast,
successful request may therefore point at a trace that was later dropped
by the `baseline` policy; Grafana shows "trace not found". The e2e test
(`test/e2e/signals.test.ts`) accounts for this by requiring _some_
exemplars to resolve, not all. Exemplars on slow buckets and on error
series always resolve, which is where they matter.

## Changing it

Edit the policies in `otel/collector.yaml` and restart the Collector
(`docker compose restart otel-collector`); the services do not need to
know. The `Queues & pipeline` dashboard shows sampled vs dropped counts by
policy (`otelcol_processor_tail_sampling_count_traces_sampled`), which is
how to check a change did what was intended.
