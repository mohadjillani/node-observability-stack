# ADR 0001: The Collector is the single ingestion point

**Status:** accepted · **Date:** 2026-08-30

## Context

The OpenTelemetry SDK can export straight to a backend: Tempo accepts
OTLP, Prometheus can scrape the services, Loki can be pushed to. Two
services and three backends is six direct paths, each configured in
application code or environment, each with its own retry and batching
behaviour, and each to be re-pointed when a backend changes.

The alternative is an OpenTelemetry Collector between the services and
the backends: the services send OTLP to one address and know nothing
else.

## Decision

Everything the services emit as telemetry goes to the Collector
(`otel/collector.yaml`):

- **Traces** over OTLP/HTTP. The Collector applies tail sampling
  ([ADR 0003](0003-tail-sampling-in-the-collector.md)), batches, and
  exports to Tempo.
- **Metrics** by the Collector _scraping_ the services' `/metrics`
  endpoints and re-exporting the series on `:8889`, which is the one
  target in Prometheus' scrape config. Exemplars survive the hop
  ([ADR 0005](0005-exemplars-as-the-metrics-to-traces-link.md)).

Container **logs** are the exception: Alloy reads them from Docker and
writes to Loki directly ([ADR 0004](0004-alloy-over-promtail.md)). The
services still know nothing about Loki; the exception is in the
pipeline, not in the code.

The services' configuration for all of this is one variable,
`OTEL_EXPORTER_OTLP_ENDPOINT`. Swapping Tempo for a vendor, adding a
second destination, changing the sampling policy, redacting an attribute
— each is an edit to the Collector config and a restart of one
stateless container. The SDK's exporter has a bounded queue with
retries, so a Collector restart costs a few seconds of spans, never a
blocked request.

## Consequences

- One more component to run. It is stateless and cheap; in Kubernetes
  it is a DaemonSet or a sidecar, in Compose it is one container.
- The Collector is a single point of failure for telemetry, not for the
  application. `CollectorExportFailing` and the pipeline panels on the
  Queues dashboard watch it; the services degrade to "no traces" and
  nothing else.
- Tail sampling needs whole traces on one instance. One Collector makes
  that trivial; scaling it out means a trace-id-aware load-balancing
  tier in front (`docs/sampling.md`, Topology).
- Metrics take one extra hop (service → Collector → Prometheus) and
  carry `service_name`/`service_instance_id` labels from the Collector's
  scrape, matching the resource attributes on traces.
- The trigger for revisiting: an environment that already has a managed
  agent (Grafana Alloy in OTLP mode, a vendor agent) doing this job. The
  services would not change; the Collector config would move.
