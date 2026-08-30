# Contributing

## Setup

```sh
git clone https://github.com/mohadjillani/node-observability-stack
cd node-observability-stack
npm ci
npm test
```

Node 22 or newer (`.nvmrc` pins 22, the version the images use). `npm test` builds first, then runs the unit suites; the cross-process trace test needs Redis and PostgreSQL and skips without them:

```sh
docker compose up -d redis postgres
REDIS_URL=redis://127.0.0.1:6379 \
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/orders npm test
```

The end-to-end suite needs the whole stack:

```sh
docker compose up --build --wait
ROUNDS=3 ./scripts/break-it.sh
E2E=1 npm run test:e2e
```

## Scripts

| Script                           | What it does                                                                |
| -------------------------------- | --------------------------------------------------------------------------- |
| `npm run build`                  | `tsc -b` for the telemetry package and both services                        |
| `npm test`                       | Builds, then unit suites and the cross-process trace test, with coverage    |
| `npm run test:e2e`               | Checks against Tempo, Loki, Prometheus and Grafana (`E2E=1`, stack running) |
| `npm run lint`                   | ESLint with type-aware rules                                                |
| `npm run typecheck`              | `tsc --noEmit` over every package, service and test                         |
| `npm run format:check`           | Prettier                                                                    |
| `npm run dev -w services/api`    | The api with `tsx watch`, reading `.env` from the repository root           |
| `npm run dev -w services/worker` | Same for the worker                                                         |
| `./scripts/break-it.sh`          | Traffic with slow paths, failed jobs, 4xx and unmatched routes              |
| `./scripts/overhead/run.sh`      | The k6 overhead comparison (needs k6); `report.ts` renders it               |

Alert rules are tested with promtool; CI runs it from the Prometheus image, or locally:

```sh
docker run --rm -v "$PWD/prometheus:/prometheus:ro" --entrypoint promtool prom/prometheus:v3.0.1 \
  test rules /prometheus/tests/alerts.test.yml
```

## Making a change

1. Branch from `main`.
2. Tests go with the change. A new span or attribute belongs in the cross-process test; a new metric belongs in `packages/telemetry/test/metrics.test.ts` and, if it has a route or queue label, under the cardinality guard; a new alert rule needs a case in `prometheus/tests/`.
3. A change to a dashboard is a change to the JSON under `grafana/dashboards/` (export from Grafana, keep the `uid`).
4. If the change is a decision someone would ask about, add an ADR under `docs/adr/` and link it from the index and the README.
5. Open a pull request.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:`, `refactor:`.
