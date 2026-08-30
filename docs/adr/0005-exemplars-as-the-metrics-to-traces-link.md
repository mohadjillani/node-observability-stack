# ADR 0005: Exemplars link metrics to traces, and that decides the metrics library

**Status:** accepted · **Date:** 2026-08-30

## Context

A dashboard says p95 went up. Without exemplars the next step is a
search: find traces in that window, sort by duration, hope. An exemplar
is a trace id attached to a histogram sample, so a point on the latency
graph _is_ a trace: click it and Tempo opens the request that landed in
that bucket.

Two ways to produce them from Node:

1. The **OpenTelemetry metrics API** (`@opentelemetry/sdk-metrics`)
   exported over OTLP to the Collector. The obvious choice next to the
   OTel tracing SDK: one API, one exporter, resource attributes shared.
2. **prom-client** rendering OpenMetrics text with `# {trace_id=…}`
   exemplars, scraped.

## Decision

prom-client (`packages/telemetry/src/metrics.ts`), for one decisive
reason: **the JavaScript metrics SDK does not record exemplars.** As of
`@opentelemetry/sdk-metrics` 2.10 the exemplar reservoir and filter
classes exist in the package but nothing in the aggregation path uses
them and the OTLP serialiser does not emit them. Option 1 would have
produced histograms with no trace ids in them, and the link this
repository exists to demonstrate would not work.

prom-client 15 attaches exemplar labels to histogram and counter
observations and renders them in OpenMetrics format. The helpers in
`metrics.ts` read the active span from the OpenTelemetry context — the
same source the logger uses — so the exemplar is the trace of the
request being timed. The Collector scrapes the endpoints (prometheus
receiver, which keeps exemplars) and re-exports them with
`enable_open_metrics: true`; Prometheus runs with
`--enable-feature=exemplar-storage`; Grafana's Prometheus datasource has
`exemplarTraceIdDestinations` pointing at Tempo.

The SDK's own metric pipeline is switched off (`OTEL_METRICS_EXPORTER=none`)
so the http instrumentation's duration histogram does not exist next to
ours with a different label set.

## Consequences

- Two libraries for two signals. The application code sees one package
  (`@mohadjillani/telemetry`); the split is inside it.
- Metrics are pulled, not pushed. The worker therefore runs a small HTTP
  listener for `/metrics` (`services/worker/src/metrics-server.ts`).
- Metric names follow Prometheus conventions
  (`http_server_request_duration_seconds`) rather than OTel's
  (`http.server.request.duration`); the Collector would have translated
  one into the other anyway.
- Route labels are templates, enforced by a test
  (`services/api/test/metrics.test.ts`), because exemplars or not, a raw
  path in a label is how monitoring falls over in production.
- An exemplar on a fast, successful request may point at a trace tail
  sampling dropped (ADR 0003). Exemplars on slow and failing samples —
  the ones worth clicking — always resolve.
- The trigger for revisiting: exemplar support landing in the JS metrics
  SDK. Then `metrics.ts` can move to the OTel API, the Collector's
  prometheus receiver goes away, and everything is OTLP. The public
  helper signatures would not change.
