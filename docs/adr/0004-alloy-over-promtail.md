# ADR 0004: Container logs through Alloy, straight to Loki

**Status:** accepted · **Date:** 2026-08-30

## Context

The services write one JSON line per event to stdout with `trace_id` and
`span_id` on every line that has a span (`packages/telemetry/src/logger.ts`).
Something has to get those lines into Loki. Options:

1. **Promtail** reading the Docker log driver. The classic choice; in
   long-term support only since Alloy replaced it.
2. **Grafana Alloy**, Promtail's successor, doing the same job with the
   same pipeline stages, and also able to speak OTLP.
3. **The pino OpenTelemetry instrumentation** sending log records over
   OTLP to the Collector, which exports to Loki — no log agent at all.
4. Alloy reading Docker logs but forwarding through the Collector rather
   than to Loki directly, so the Collector remains the single ingestion
   point (ADR 0001) for all three signals.

## Decision

Option 2: Alloy tails the Docker socket for the two demo services,
extracts `level` as a label and `trace_id`/`span_id` as structured
metadata, and pushes to Loki (`alloy/config.alloy`).

Not Promtail because it is end-of-life; the configuration is a
straightforward translation and Alloy is what a new deployment would
pick. Not option 3 because it changes what a log _is_: lines would leave
the process over the network from inside the process, so a log that
matters most — the one written while the Collector is unreachable, or
during a crash — is the one most likely lost. stdout is the contract
between a container and its platform; every orchestrator collects it,
and the services keep working, and logging, whatever the pipeline is
doing. (The pino instrumentation is explicitly disabled in the SDK setup
so it does not send a second copy.)

Not option 4 because Loki's native OTLP ingestion maps attributes and
resources to labels in ways that take tuning to keep the label set small,
and the demo gains nothing from the extra hop. It is the right shape when
the Collector is already the fleet's log path; the change is a
`loki.write` → `otelcol.exporter.otlphttp` swap in Alloy and a logs
pipeline in the Collector.

`trace_id` is structured metadata, not a label: a label per trace id
would create one stream per request and destroy Loki's index. As
metadata it is still a first-class filter (`| trace_id = "…"`), which is
what Grafana's trace-to-logs link uses.

## Consequences

- One agent per host (Alloy) with Docker socket access. In Kubernetes
  it is a DaemonSet reading `/var/log/pods`; the pipeline stages are the
  same.
- Log lines carry the ids because the _logger_ put them there, from the
  same context the tracer uses. The agent does not parse trace ids out
  of free text; it just moves the field.
- Only `api` and `worker` logs are shipped. The backends' own logs are
  visible with `docker compose logs` and are not part of the demo.
- The trigger for revisiting: a platform where stdout is not collected
  (some serverless runtimes), where option 3 becomes the only path.
