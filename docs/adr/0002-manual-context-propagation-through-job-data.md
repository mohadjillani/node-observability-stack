# ADR 0002: Trace context crosses the queue in the job data, by hand

**Status:** accepted · **Date:** 2026-08-30

## Context

HTTP propagation is automatic: the http instrumentation injects
`traceparent` on outgoing requests and extracts it on incoming ones. A
queue has no headers. When the api enqueues a job and the worker picks
it up seconds later on another process, the trace ends at the enqueue
unless something carries the context across.

Options:

1. **BullMQ's telemetry hook.** BullMQ 5 has a `telemetry` option and a
   `bullmq-otel` package that implement propagation and spans for
   `add`/`process` internally.
2. **A community instrumentation** for BullMQ that patches the library
   the way `instrumentation-ioredis` does.
3. **Do it explicitly**: inject the W3C carrier into the job's data on
   the way in, extract it on the way out, and create the producer and
   consumer spans in the application.

## Decision

Option 3, as `injectTraceContext` / `extractTraceContext` /
`withProducerSpan` / `withConsumerSpan` in `packages/telemetry/src/propagation.ts`.

It is about sixty lines including the span attributes, it uses the same
global propagator as HTTP (so `tracestate` and any future baggage come
along for free), and it is explicit in the two places that matter: the
api's `queue.add` and the worker's processor. Anyone reading either
service sees where the context goes.

The consumer span does two things at once: it **continues** the
producer's trace (its parent is the extracted remote context), so one
trace id covers request → queue → worker → callback, _and_ it carries a
**link** to the producer span. The link is what remains when
`continueTrace: false` is chosen — the right shape for batch consumers
or jobs that can sit in a queue for hours, where one trace stops being a
useful unit and a link back is enough.

The mechanism is proven twice: `packages/telemetry/test/propagation.test.ts`
round-trips through JSON with an in-memory exporter, and
`test/integration/trace-across-queue.test.ts` does it across real
processes and real Redis.

## Consequences

- The job data has a `traceContext` field. It is small (a `traceparent`
  is 55 characters) and it is visible in Redis, which helps when
  debugging by hand.
- Producers that do not use the helper (a script, another language)
  produce jobs without a carrier; the consumer then starts a fresh trace
  with no link, which is correct and tested.
- The spans are ours, so their names and attributes follow the messaging
  semantic conventions as far as they are stable and use a
  `messaging.bullmq.*` namespace for the rest (job name, attempt, queue
  wait time). A library's spans would be its choice.
- Retries: each attempt is a new consumer span in the same trace, with
  `messaging.bullmq.job.attempt` set, so a job that failed twice and
  succeeded reads as three spans under one producer.
- The trigger for revisiting: BullMQ's own telemetry interface
  stabilising to the point where it produces the same shape (continued
  trace plus link) with less code. Then this helper becomes an adapter
  or goes away.
