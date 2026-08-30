# Alerting

Six rules in `prometheus/rules/alerts.yml`, each unit-tested in
`prometheus/tests/alerts.test.yml` (`promtool test rules`, run in CI).
This page is why each exists, what to do when it fires, and — as
importantly — what is deliberately not alerted on.

The stack has no Alertmanager: rules evaluate in Prometheus and show as
pending/firing at `http://localhost:9090/alerts` and in Grafana under
Alerting → Alert rules (data-source-managed). Adding delivery is an
Alertmanager container plus `alerting:` in `prometheus/prometheus.yml`;
routing by the `severity` label below is the intended shape.

## Principles

- **Symptoms, not causes.** Users see error rates and latency; they do
  not see CPU. A rule on a symptom fires for causes nobody predicted.
- **Two severities.** `page` wakes someone: users are affected _now_ and
  it will not fix itself. `ticket` is looked at during working hours.
  Most rules are tickets.
- **Every rule has a floor or a `for`.** Ratios on tiny denominators and
  single-sample spikes are the main source of alert fatigue; each rule
  says how it avoids them.
- **Every rule links here.** The `runbook` annotation points at the
  heading below, so the first thing on call sees is what to do.

## The rules

### HighErrorRate

`severity: page`. More than 5% of requests to a service returned 5xx
over 2 minutes, **and** the service is handling more than 1 request per
second.

_Why the floor:_ at 0.4 req/s, one failed request in ten is a 50% error
ratio for two minutes. Without the floor, the quietest hour of the night
is when this pages. The unit test `error rate ignores a high ratio on
negligible traffic` pins that.

_Why 5% / 2m:_ a deploy that rolls one bad instance, or one dependency
timing out for a few requests, stays under it; a real outage is well
over it within a minute.

_First steps:_ RED dashboard → 5xx ratio panel → the route split; then
follow an exemplar on the 5xx series to a trace with the error span.
Every 5xx trace is kept by tail sampling (`docs/sampling.md`).

### HighLatencyP95

`severity: ticket`. The 95th percentile of request latency for a service
has been above 500 ms for 5 minutes.

_Why p95, not p99:_ p99 on a low-traffic service is one slow request per
minute; it flaps. p95 needs a pattern.

_Why 500 ms:_ the same threshold as the `slow` tail-sampling policy, so
the traces behind this alert exist. In a real service the number comes
from the SLO, and routes with different budgets get separate rules —
here `/internal/pricing` with a `SLOW-` sku is _meant_ to take 1.5 s, and
`break-it.sh` will trip this alert on purpose.

_First steps:_ RED dashboard → p95 by route; click an exemplar above the
line to see where the time went.

### QueueBacklog

`severity: ticket`. More than 100 jobs have been waiting on a queue for 5
minutes.

_Why 100 / 5m:_ sized to the demo. The right threshold is the acceptable
processing delay times the drain rate of one worker: if a job may wait 2
minutes and a worker does 5 jobs/s, anything over ~600 waiting is late by
definition. A short spike from a burst of orders drains and never fires
(`a short spike in the backlog does not fire`).

_First steps:_ Queues dashboard. Is `active` at the concurrency limit
(workers saturated — scale out) or zero (workers gone — see
WorkerAbsent)? Is `failed` growing (jobs retrying with backoff — find
the error trace)?

### WorkerStalledJobs

`severity: ticket`. A job's lock expired while a worker held it, in the
last 10 minutes. Fires immediately (`for: 0m`) because one stall is
already information: a worker died mid-job, blocked its event loop past
`lockDuration`, or the job is longer than the lock.

BullMQ hands the job to another worker, so nothing is lost — but the
job ran twice, which matters if it is not idempotent. Stalls that repeat
mean the lock duration or the job design is wrong, not the infrastructure.

_First steps:_ worker logs (`job stalled` lines carry the job id), then
the worker's event-loop lag on the RED dashboard.

### WorkerAbsent

`severity: page`. `queue_depth` has not been scraped for 2 minutes.

_Why `absent()`:_ a dead worker does not report a large backlog; it
reports nothing, and every threshold rule stays quiet. This is the rule
that catches the failure the others cannot see. The 2 minutes cover a
restart.

_First steps:_ `docker compose ps worker`; if it is up, the Collector's
scrape of `worker:9464` (`otelcol_scraper_errored_metric_points`).

### CollectorExportFailing

`severity: ticket`. The Collector has failed to export spans for 5
minutes. Dashboards go quiet, nobody notices — unless the pipeline
watches itself. The services are unaffected (their exporter queue drops
after it fills), which is why this is a ticket, not a page.

_First steps:_ Collector logs; is Tempo up (`/ready`)?

## Deliberately not alerted

- **CPU and memory of the services.** Causes, not symptoms. If they
  matter, they show up as latency or errors, which are covered.
- **A single 5xx**, or the error _count_ rather than ratio. Counts scale
  with traffic; a rule on them is re-tuned every time traffic changes.
- **p99 latency.** See HighLatencyP95.
- **Event-loop lag.** Useful on a dashboard for diagnosing; as an alert
  it fires on GC pauses that users never notice.
- **Redis or PostgreSQL connectivity.** They surface as `/readyz` going
  503 and as 5xx on the routes that need them; a dependency alert would
  fire at the same time as HighErrorRate and add nothing.
- **Container restarts.** A restart that leaves no user-visible symptom
  is not an incident; one that does is already covered.
- **Tail-sampling drop counts.** Dropping is the intended behaviour.

## Alert fatigue

The failure mode of alerting is not missing alerts; it is people learning
to ignore them. The rules above are few, each has a documented reason
and a test, and each changes when the system changes: the `100` in
QueueBacklog and the `500 ms` in HighLatencyP95 are explicitly demo
numbers. When one fires and the response is "that's fine", the rule is
wrong and should be changed, not muted.

## Testing

```sh
docker run --rm -v "$PWD/prometheus:/prometheus:ro" --entrypoint promtool prom/prometheus:v3.0.1 \
  test rules /prometheus/tests/alerts.test.yml
```

Each test feeds synthetic series and asserts firing or not at a point in
time. They pin intent (a floor, a `for`), not PromQL syntax. CI runs them
on every push.
