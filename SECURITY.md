# Security

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability) rather than a public issue. Reports are acknowledged within a few days.

## What this stack is

A local reference stack. It is configured to be looked at, not exposed:

- **Grafana runs with anonymous admin access** and the login form disabled (`docker-compose.yml`). That is deliberate for a laptop and unacceptable anywhere reachable; set `GF_AUTH_ANONYMOUS_ENABLED=false` and provision users before binding it to anything but localhost.
- **Every backend port is published to the host** (Prometheus, Tempo, Loki, the Collector's OTLP and metrics endpoints, Alloy). None of them authenticate. Behind a network boundary they should not be published at all.
- **Alloy mounts the Docker socket** read-only to discover containers and read their logs. Socket access is host-level access; in a real deployment the agent reads log files under `/var/log/pods` or the equivalent instead.
- **PostgreSQL and Redis** use default credentials and no TLS.

## What the services do

- **No secrets in telemetry.** Span attributes come from the instrumentations' defaults (method, route, status, database statement summaries) and the propagation helpers (queue, job name, job id). The `authorization` header is not captured by the http instrumentation by default; if request or response headers are ever added as attributes, redact them in the Collector (`attributes`/`redaction` processors) rather than trusting every service to.
- **Log lines** carry ids and business fields (order id, sku, totals). Nothing in the demo is sensitive; a real service should apply pino's `redact` option to anything that is, and the line is still shipped verbatim by Alloy.
- **Route labels are templates**, enforced by a test, so a client cannot mint metric series by requesting arbitrary paths.
- **Input is validated** with zod at the two endpoints that take it; JSON bodies are capped at 16 kB.
- **The images run as the non-root `node` user**, production dependencies only, `tini` as PID 1.
- **`npm audit`** runs in CI at high severity.

## What they do not do

- **No authentication or authorisation** on the api; every route, including `/internal/pricing`, is public. In a real system the `/internal/*` routes are reachable only from the worker's network and `/metrics` only from the Collector.
- **No TLS** anywhere; terminate it in front.
- **No rate limiting.**
