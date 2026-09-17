# node-observability-stack

[![ci](https://github.com/mohadjillani/node-observability-stack/actions/workflows/ci.yml/badge.svg)](https://github.com/mohadjillani/node-observability-stack/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Traces, metrics, logs — one compose file, wired together.** Two Node services (an HTTP API, a BullMQ worker, and a call back from the worker into the API) instrumented with OpenTelemetry, shipped through an OpenTelemetry Collector into Tempo, Prometheus and Loki, with Grafana provisioned so that a point on a latency graph opens the trace behind it and a span lists the log lines written under it. One order produces one trace across four hops and a queue, and a test proves it.

A production-oriented reference stack: the pipeline configuration is the product, the services exist to have something to observe. The instrumentation conventions here are the ones [`node-service-blueprint`](https://github.com/mohadjillani/node-service-blueprint) adopts; the shared bootstrap lives in `packages/telemetry`.

| Decision                                                          | Why, in one line                                                                                                         | ADR                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| The Collector is the only thing the services know about           | Sampling, batching, retries and backend swaps happen in one stateless place; the services carry one URL                  | [0001](docs/adr/0001-collector-as-the-single-ingestion-point.md)                 |
| Trace context crosses the queue in the job data, by hand          | Sixty explicit lines, the same propagator as HTTP, a consumer span that continues the trace _and_ links to the producer  | [0002](docs/adr/0002-manual-context-propagation-through-job-data.md)             |
| Tail sampling in the Collector, not head sampling in the SDK      | Head sampling decides before the outcome is known and drops the errors you wanted; tail keeps every error and slow trace | [0003](docs/adr/0003-tail-sampling-in-the-collector.md)                          |
| Logs via Alloy from stdout, `trace_id` as structured metadata     | stdout is the contract with the platform; a trace id per label would destroy Loki's index                                | [0004](docs/adr/0004-alloy-over-promtail.md)                                     |
| Exemplars are the metrics→traces link, so metrics use prom-client | The JS metrics SDK does not record exemplars; without them metrics and traces are silos                                  | [0005](docs/adr/0005-exemplars-as-the-metrics-to-traces-link.md)                 |
| ESM instrumentation through Node's synchronous loader hook        | The off-thread loader deadlocked the worker on every other start; the in-thread hook has no handshake to deadlock        | [0006](docs/adr/0006-esm-instrumentation-through-the-synchronous-loader-hook.md) |
| Model cost is a derived series, not a `gen_ai` one                | The conventions define no cost metric because a provider reports tokens, not what they cost this account                 | [0007](docs/adr/0007-cost-is-derived-so-it-does-not-carry-the-genai-prefix.md)   |

## Architecture

```mermaid
flowchart LR
  subgraph demo [the demo]
    C[client] -->|POST /orders| API[api<br/>express · pg · bullmq]
    API -->|job + traceparent| R[(redis)]
    R --> W[worker<br/>bullmq · pg]
    W -->|GET /internal/pricing<br/>traceparent header| API
    API --> PG[(postgres)]
    W --> PG
  end

  API -.->|OTLP traces| COL
  W -.->|OTLP traces| COL
  COL -.->|scrape /metrics<br/>OpenMetrics + exemplars| API
  COL -.->|scrape /metrics| W
  API -.->|stdout json| ALLOY[alloy]
  W -.->|stdout json| ALLOY

  subgraph pipeline [the pipeline]
    COL[otel collector<br/>tail sampling · batch]
    COL -->|traces| TEMPO[(tempo)]
    COL -->|series + exemplars| PROM[(prometheus)]
    ALLOY -->|lines + trace_id metadata| LOKI[(loki)]
  end

  PROM ==>|exemplar → trace| TEMPO
  TEMPO ==>|span → lines by trace_id| LOKI
  LOKI ==>|line → trace| TEMPO
  TEMPO ==>|span → RED series| PROM
  G[grafana<br/>provisioned datasources,<br/>correlations, dashboards] --- PROM
  G --- TEMPO
  G --- LOKI
```

Dotted lines are telemetry leaving the services; the thick lines are the links Grafana is provisioned with ([`grafana/provisioning/datasources/datasources.yaml`](grafana/provisioning/datasources/datasources.yaml)).

## Quick start

Requires Docker with Compose. Everything is pinned and healthchecked, so `--wait` returns when the stack is actually ready.

```sh
git clone https://github.com/mohadjillani/node-observability-stack
cd node-observability-stack
docker compose up --build --wait
./scripts/break-it.sh          # orders that are fine, slow (SLOW-*), and fail in the worker (FAIL-*)
open http://localhost:3001     # grafana, anonymous admin (local only)
```

Ports: api `3000` · Grafana `3001` · Prometheus `9090` · Tempo `3200` · Loki `3100` · Collector `4317`/`4318` (OTLP) and `8889` (re-exported metrics). CI brings this exact stack up and runs [`test/e2e/`](test/e2e) against it on every push.

## What to look at

Four dashboards are provisioned; **Drilldown** (`/d/nos-drilldown`) is the tour.

1. **Metric → trace.** On the _api latency p95_ panel, the diamonds are exemplars: each is one real request in that histogram bucket, carrying its `trace_id`. Hover one and choose _Query with Tempo_. Slow requests from `break-it.sh` (`SLOW-*` skus, 1.5 s in the pricing hop) sit well above the line.
2. **The trace.** It runs `POST /orders` → `orders send` (producer) → `orders process` (consumer, in the worker) → `GET /internal/pricing` (api again), with the pg and Redis client spans under each. The consumer span shows the queue hop as a link to the producer span and carries `messaging.bullmq.job.wait_ms`. A `FAIL-*` order has the pricing span in red and three consumer spans — one per attempt — under one producer.
3. **Trace → logs.** Click a span, then _Logs for this span_. Grafana runs `{service=~"api|worker"} | trace_id = "…"` — a structured-metadata filter, not a text search — and lists every line both services wrote under that trace. Each line has a _View trace_ button back.
4. **RED** (`/d/nos-red`) is per service by route template: rate, 5xx ratio, p50/p95/p99 with exemplars, in-flight requests, event-loop lag. **Queues & pipeline** (`/d/nos-queues`) has depth by state, throughput by outcome, job duration with exemplars, stalls, and the Collector's own receive/export/tail-sampling counters. **Model calls & spend** (`/d/nos-model`) covers the worker's model call: calls per second by outcome, duration and tokens with exemplars, and spend split by token type.
5. **Alerts.** `http://localhost:9090/alerts`. After `break-it.sh`, `HighLatencyP95` goes pending; `HighErrorRate` does not, because the failing path is the worker's job, not the client-facing request — that shows up in `queue_depth{state="failed"}` instead. Each rule's reasoning is in [`docs/alerting.md`](docs/alerting.md).

Explore works too: TraceQL `{ span.messaging.system = "bullmq" && kind = consumer }` in Tempo lists every job trace; `{service="worker"} | json | level = "warn"` in Loki shows the retries.

## The headline test

[`test/integration/trace-across-queue.test.ts`](test/integration/trace-across-queue.test.ts) starts the built api and worker as real processes, exactly as the images start them (`node --import @mohadjillani/telemetry/register …`), with the test standing in for the Collector as an OTLP/HTTP receiver. It posts one order and asserts:

- one trace id across the `POST /orders` server span, the producer span, the worker's consumer span, the worker's client call and the `GET /internal/pricing` server span — plus pg and Redis spans from the auto-instrumentation;
- the consumer span's parent is the producer span and it carries a link to it;
- every log line about the order, in both services, carries that trace id and the span id of the span it was written under;
- both services' `/metrics` show the order's trace id as an exemplar on the `/orders` and job-duration histograms, and no label anywhere looks like an id.

It runs on `npm test` when `REDIS_URL` and `DATABASE_URL` are set, and in CI on Node 22 and 24 against service containers. [`test/e2e/signals.test.ts`](test/e2e/signals.test.ts) repeats the argument against the real backends after `compose up`: Loki → trace id → Tempo → both services with the link → Loki by metadata → a Prometheus exemplar that resolves in Tempo → an error trace kept by tail sampling → rules, datasources, dashboards and correlations present.

## The telemetry package

`packages/telemetry` is what a service imports. It is structured to be published later; here it is a workspace package.

```ts
// Started before the app is imported:  node --import @mohadjillani/telemetry/register dist/main.js
// (OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT; OTEL_SDK_DISABLED=true skips it all)

import {
  createLogger,
  createMetrics,
  injectTraceContext,
  withProducerSpan,
  withConsumerSpan,
} from '@mohadjillani/telemetry';

const logger = createLogger({ service: 'api' }); // every line: trace_id, span_id when a span is active
const metrics = createMetrics({ service: 'api' }); // prom-client, OpenMetrics, exemplars from the active span
app.use(metrics.httpMiddleware()); // http_server_request_duration_seconds{method,route,status_code}
app.get('/metrics', metrics.handler());

// Producer: the job carries the W3C context in its data.
await withProducerSpan(tracer, { queue: 'orders', jobName: 'order.process' }, async (span) => {
  const job = await queue.add('order.process', injectTraceContext({ orderId }));
  span.setAttribute('messaging.message.id', job.id);
});

// Consumer: continues the trace (or `{ continueTrace: false }` for a linked, separate one).
await withConsumerSpan(
  tracer,
  { queue, jobName: job.name, jobId: job.id, data: job.data },
  async () => {
    logger.info({ orderId }, 'processing order'); // carries the consumer span's ids
  },
);
```

What each service emits:

| Signal  | Where it goes              | What                                                                                                                                                                                                                                                   |
| ------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Traces  | OTLP/HTTP → Collector      | http, express (router + handler, middleware spans dropped), pg, ioredis and undici auto-instrumentation; `orders send` / `orders process` from the helpers with `messaging.*` attributes; probes and `/metrics` ignored                                |
| Metrics | `/metrics`, scraped        | `http_server_request_duration_seconds`, `http_server_active_requests`, `queue_job_duration_seconds{queue,name,outcome}`, `queue_depth{queue,state}`, `queue_jobs_stalled_total`, Node runtime metrics; histograms carry `trace_id`/`span_id` exemplars |
| Logs    | stdout JSON → Alloy → Loki | pino; `service`, `level`, `time`, `msg`, business fields, and `trace_id`/`span_id`/`trace_flags` from the active span; `level` becomes a Loki label, the ids become structured metadata                                                                |

### Model calls

`withModelSpan` wraps a call to a model provider in a span carrying the [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai) — `gen_ai.operation.name`, `gen_ai.provider.name`, the request and response models and the token counts — named `{operation} {model}`, as the conventions specify.

```ts
const note = await withModelSpan(
  {
    operation: 'chat',
    provider: 'openai',
    requestModel: 'gpt-4o-mini',
    onObservation: (observation) => metrics.observeModelCall(observation),
  },
  async (report) => {
    const response = await client.chat(prompt);
    // Usage arrives in the last chunk of the stream, not as a return value.
    report({ inputTokens: response.usage.input, outputTokens: response.usage.output });
    return response.text;
  },
);
```

Three series come out of it. Two are the conventions' own, with their recommended buckets: `gen_ai_client_operation_duration_seconds` and `gen_ai_client_token_usage`, split by `gen_ai_token_type`. The third, `model_cost_usd_total`, deliberately does **not** carry the `gen_ai` prefix — the conventions define no cost metric, because a provider reports tokens, not what they cost this account. Cost here is tokens times a price list held in configuration, and a model missing from that list records tokens with no cost rather than a silent undercount ([ADR 7](docs/adr/0007-cost-is-derived-so-it-does-not-carry-the-genai-prefix.md)).

Prompt and completion text are never recorded. The conventions describe opt-in content capture; this stack does not implement it.

The attribute names are constants in `packages/telemetry/src/genai.ts` rather than imports, because these conventions sit in their own repository at **Development** stability — `gen_ai.system` has already become `gen_ai.provider.name` once, and one file should absorb the next rename.

The worker's `summarise` step is the call being observed. Like `pricing` it is a deterministic stand-in: the workload exists to have something to watch.

## Sampling, alerting, overhead

- **Sampling** — every span is exported; the Collector keeps every trace with an error or a 5xx, every trace over 500 ms, and 20% of the rest, deciding 10 s after a trace starts. Why, what it costs, and how it fails: [`docs/sampling.md`](docs/sampling.md).
- **Alerting** — six rules with a floor or a `for` each, two severities, and a list of what is deliberately not alerted on; unit-tested with `promtool` in CI. [`docs/alerting.md`](docs/alerting.md).
- **Overhead** — `scripts/overhead/run.sh` runs the same k6 load with the SDK on and with `OTEL_SDK_DISABLED=true` and `report.ts` prints the comparison with its provenance. No numbers are committed; [`docs/overhead.md`](docs/overhead.md) has the method, the command, and what to expect qualitatively.

## Configuration

Both services validate their environment with zod at boot and refuse to start with every problem listed. [`.env.example`](.env.example) is the local set; `docker-compose.yml` sets the containers'.

| Variable                      | Service | Default                  | Meaning                                                           |
| ----------------------------- | ------- | ------------------------ | ----------------------------------------------------------------- |
| `DATABASE_URL`                | both    | —                        | PostgreSQL; the api creates the `orders` table on start           |
| `REDIS_URL`                   | both    | `redis://127.0.0.1:6379` | BullMQ connection                                                 |
| `QUEUE_NAME`                  | both    | `orders`                 | The queue between them                                            |
| `PORT`                        | api     | `3000`                   | `0` binds a free port and logs it                                 |
| `SLOW_PRICING_MS`             | api     | `1500`                   | Delay for `SLOW-*` skus on `/internal/pricing`                    |
| `API_URL`                     | worker  | `http://127.0.0.1:3000`  | Where the pricing hop goes                                        |
| `WORKER_CONCURRENCY`          | worker  | `5`                      | Jobs in flight per worker                                         |
| `WORKER_METRICS_PORT`         | worker  | `9464`                   | The worker's `/metrics` and `/healthz` listener                   |
| `LOG_LEVEL`                   | both    | `info`                   | pino level                                                        |
| `SHUTDOWN_TIMEOUT_MS`         | both    | `10000`                  | Drain deadline before a forced exit                               |
| `OTEL_SERVICE_NAME`           | both    | `unknown_service`        | `service.name` on traces; set per service                         |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | both    | `http://localhost:4318`  | The Collector. Unreachable is not fatal: spans drop, the app runs |
| `OTEL_SDK_DISABLED`           | both    | `false`                  | `true` skips the SDK and the loader hook (the overhead baseline)  |
| `DEPLOYMENT_ENVIRONMENT`      | both    | `local`                  | `deployment.environment.name` resource attribute                  |

## Running without Docker

```sh
npm ci
cp .env.example .env                       # point DATABASE_URL and REDIS_URL at your own
npm run build -w packages/telemetry        # the register entry is loaded from dist
npm run dev -w services/api                # tsx watch, with the loader hook
npm run dev -w services/worker
```

Without a Collector the SDK logs one warning per failed export batch and the services carry on; the log lines still carry trace ids and `/metrics` still carries exemplars.

## Testing

```sh
npm test                                   # builds, then unit suites; the cross-process test skips without services
REDIS_URL=redis://127.0.0.1:6379 DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/obs_test npm test
E2E=1 npm run test:e2e                     # against the compose stack
```

- **Unit** (`packages/telemetry/test`): propagation round trip through JSON with an in-memory exporter, continued vs link-only consumer spans, failure recording; the pino mixin following nested spans; route templates, the cardinality guard, exemplar attachment, queue depth collection.
- **HTTP** (`services/api/test`): every status the routes produce, readiness, and the guard — ids, traversal and unknown paths all land under a template or `unmatched`.
- **Worker** (`services/worker/test`): the processor against a fake pricing endpoint, success and retry paths, job metrics.
- **Cross-process** (`test/integration`): the headline above.
- **Rules** (`prometheus/tests`): `promtool test rules`, in CI.
- **End to end** (`test/e2e`): the compose stack, in CI.

Coverage is enforced in [`vitest.config.ts`](vitest.config.ts) at the level the service-less run meets; the spawned services are outside what v8 coverage can see, which is why the cross-process test asserts on their output instead. CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)): lint, format, typecheck, tests and build on Node 22 and 24 with Redis and PostgreSQL containers; `promtool` and Collector config validation from the pinned images; `npm audit`; and the stack end to end.

## Layout

```
packages/telemetry/src/
├── sdk.ts            startTelemetry(): NodeSDK, instrumentation set, OTLP trace export, shutdown
├── register.ts       the --import entry: loader hook (sync when Node can), then the SDK
├── logger.ts         createLogger(): pino with the trace/span id mixin; flushLogger()
├── propagation.ts    injectTraceContext / extractTraceContext / withProducerSpan / withConsumerSpan
└── metrics.ts        createMetrics(): RED histogram with route templates and exemplars, queue metrics, the guard
services/api/src/     config · app (routes) · db · queue (producer span) · pricing · main
services/worker/src/  config · processor (consumer span) · pricing-client · db · metrics-server · main
otel/collector.yaml   receivers, tail sampling, exporters — commented
prometheus/           prometheus.yml · rules/alerts.yml · tests/alerts.test.yml
tempo/ loki/ alloy/   one config each
grafana/              provisioning/{datasources,dashboards} · dashboards/{red,queues,drilldown,model}.json
scripts/              break-it.sh · overhead/{run.sh,k6.js,report.ts}
test/                 integration/ (cross-process) · e2e/ (compose stack)
docs/                 sampling.md · alerting.md · overhead.md · adr/0001–0006
```

## Design decisions

One record per decision a reviewer would ask about, in [`docs/adr/`](docs/adr):

1. [The Collector is the single ingestion point](docs/adr/0001-collector-as-the-single-ingestion-point.md)
2. [Trace context crosses the queue in the job data, by hand](docs/adr/0002-manual-context-propagation-through-job-data.md)
3. [Tail sampling in the Collector, not head sampling in the SDK](docs/adr/0003-tail-sampling-in-the-collector.md)
4. [Container logs through Alloy, straight to Loki](docs/adr/0004-alloy-over-promtail.md)
5. [Exemplars link metrics to traces, and that decides the metrics library](docs/adr/0005-exemplars-as-the-metrics-to-traces-link.md)
6. [ESM auto-instrumentation through the synchronous loader hook](docs/adr/0006-esm-instrumentation-through-the-synchronous-loader-hook.md)
7. [Model cost is derived from a configured price list, so it is not a `gen_ai` metric](docs/adr/0007-cost-is-derived-so-it-does-not-carry-the-genai-prefix.md)

Each names the trigger that would make it worth revisiting.

## Tradeoffs

- **Every span is produced and exported**, whatever the Collector keeps. That is the price of tail sampling; `docs/overhead.md` is how to know what it is on your hardware.
- **Two metrics libraries in spirit, one in the code.** Traces are OpenTelemetry, metrics are prom-client, because the JS metrics SDK cannot do exemplars yet. When it can, `metrics.ts` moves and nothing that calls it changes.
- **Logs bypass the Collector.** Alloy to Loki is one hop fewer and no label tuning; the cost is that the "single ingestion point" is true for OTLP, not for stdout.
- **The consumer span continues the trace by default.** Right for a request whose job runs within seconds; wrong for batch or hour-long jobs, which is what `continueTrace: false` is for.
- **One Collector.** Tail sampling on several needs a trace-aware load-balancing tier; the config here does not include it.
- **Node 22 or newer.** The synchronous loader hook is the reliable path for ESM instrumentation; older Node gets the off-thread loader, which this repository does not vouch for.

## Limits

- **Not run at scale.** Buckets, thresholds, `decision_wait`, `num_traces` and the 20% baseline are sized for a laptop demo and say so in the config.
- **No Alertmanager.** Rules evaluate and show as firing; nothing is delivered. Adding it is one container and a `severity`-based route.
- **No service graph.** Tempo's metrics-generator is not configured, so Grafana's node graph is built from the trace itself, not from aggregated span metrics.
- **No log retention or compaction configured** in Loki, and Tempo keeps one hour of blocks. Both are the demo's storage, not a policy.
- **Grafana is anonymous admin** and every backend port is published. See [`SECURITY.md`](SECURITY.md) before pointing this at anything but localhost.
- **Dashboards are JSON, not screenshots.** What each panel shows is described above and in the panel descriptions; the tour is meant to be walked, not viewed.

## Future improvements

- Tempo's metrics-generator for span metrics and the service graph, with `tracesToMetrics` switched to them.
- A trace-id-aware load-balancing Collector tier and a note on the Kubernetes shape (Collector as DaemonSet, Alloy reading `/var/log/pods`).
- `@mohadjillani/pino-context`: the logger mixin extracted with request-id support, shared with [`node-service-blueprint`](https://github.com/mohadjillani/node-service-blueprint).
- The same bootstrap in [`llm-service-starter`](https://github.com/mohadjillani/llm-service-starter), where the interesting spans are model calls; and the Prometheus conventions here are the ones [`socketio-scale-template`](https://github.com/mohadjillani/socketio-scale-template) already exposes.
- Moving `metrics.ts` to the OpenTelemetry metrics API when it records exemplars.

## License

MIT © Mohad Jillani
