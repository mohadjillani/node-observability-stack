# Instrumentation overhead

What the OpenTelemetry SDK, the auto-instrumentation and the metrics
middleware cost the api under load, measured rather than quoted.

**No numbers are committed here.** The measurement needs Docker and k6,
which are not available where this repository was written, so the table
below is the output format. Run it to populate:

```sh
docker compose up --build --wait
./scripts/overhead/run.sh              # two k6 runs: SDK on, then OTEL_SDK_DISABLED=true
npx tsx scripts/overhead/report.ts     # renders the markdown table from scripts/overhead/results/
```

## Method

`scripts/overhead/run.sh` recreates the `api` and `worker` containers
twice, with `OTEL_SDK_DISABLED=false` and `=true`, and drives the same
load each time with `scripts/overhead/k6.js`: a constant arrival rate
(default 100 req/s for 60 s) of `POST /orders` with a `GET /orders/:id`
every fourth iteration. Constant arrival rate rather than constant VUs,
so a slower system gets the _same_ load instead of less.

Per run it records:

- from k6: throughput, p50/p95/p99 latency, failed request ratio;
- from Prometheus, over the run window, for the api process: average CPU
  (`process_cpu_seconds_total`), peak RSS
  (`process_resident_memory_bytes`), peak event-loop lag p99
  (`nodejs_eventloop_lag_p99_seconds`).

With the SDK disabled the register entry (`packages/telemetry/src/register.ts`)
skips both the loader hook and the SDK, so the baseline is the process
with no instrumentation loaded — not merely a no-op exporter. prom-client
metrics stay on in both runs (they are how the process is measured), so
the comparison isolates tracing: span creation, context propagation, the
ESM loader wrappers, and OTLP serialisation and export.

## Output

| Metric                       | Instrumented | Baseline (OTEL_SDK_DISABLED=true) | Delta |
| ---------------------------- | -----------: | --------------------------------: | ----: |
| Throughput (req/s)           |              |                                   |       |
| Latency p50 (ms)             |              |                                   |       |
| Latency p95 (ms)             |              |                                   |       |
| Latency p99 (ms)             |              |                                   |       |
| Failed requests              |              |                                   |       |
| api CPU (cores, avg)         |              |                                   |       |
| api RSS (MB, max)            |              |                                   |       |
| Event loop lag p99 (ms, max) |              |                                   |       |

`report.ts` prints this table with a provenance line: load, duration,
machine, Node version, date, and the command that produced it. Paste it
here with that line intact; a number without its provenance is a claim.

## What to expect, qualitatively

Where the cost comes from, in rough order:

1. **Span creation and attributes.** Each `POST /orders` produces about
   six spans in the api (server, router, handler, two pg queries, the
   producer span and its Redis commands). Each is an object with a
   dozen attributes and a timer.
2. **Export.** The batch processor serialises spans to OTLP JSON every
   `OTEL_BSP_SCHEDULE_DELAY` (5 s default) and POSTs them; this is
   off the request path but on the event loop. Protobuf
   (`exporter-trace-otlp-proto`) is cheaper on the wire at the cost of a
   larger dependency.
3. **Context propagation.** `AsyncLocalStorage` per request; small but
   on every `await`.
4. **The loader hook.** Wrapped ESM modules go through a proxy layer
   once at import time; there is no per-call cost after startup, but
   startup itself is slower.
5. **RED middleware.** One `hrtime` pair and one histogram observe per
   request; negligible next to the above.

The `fs`, `net` and `dns` instrumentations are disabled precisely because
they would dominate this list while adding nothing to the traces.

## Limits of the measurement

- Two runs on one machine with Docker in between. Run-to-run noise can
  be several percent; run each side more than once before believing a
  small delta.
- The load generator, the services and the backends share the machine's
  CPU. The instrumented run also makes the Collector, Tempo and
  Prometheus work harder, which steals cycles from the api and inflates
  the delta.
- 100 req/s is a demo rate. The relative overhead usually shrinks as
  request handling gets heavier (a real handler does more work per span)
  and grows as it gets lighter.
- The baseline still runs prom-client and pino. The cost of _those_ is
  not measured here.
