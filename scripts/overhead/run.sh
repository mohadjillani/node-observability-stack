#!/usr/bin/env sh
# Measures what the instrumentation costs: the same k6 load against the api
# twice — SDK on, then OTEL_SDK_DISABLED=true — and records k6's latency
# and throughput plus the api container's CPU and memory from Prometheus.
#
# Requires: docker compose (the stack), k6, curl. From the repository root:
#
#   ./scripts/overhead/run.sh
#   npx tsx scripts/overhead/report.ts        # prints the markdown table
#
# Method and caveats: docs/overhead.md. Two runs on one laptop is a
# comparison, not a benchmark; the report says so.
set -eu

API_URL="${API_URL:-http://localhost:3000}"
PROMETHEUS_URL="${PROMETHEUS_URL:-http://localhost:9090}"
RATE="${RATE:-100}"
DURATION="${DURATION:-60s}"
RESULTS=scripts/overhead/results
mkdir -p "$RESULTS"

command -v k6 >/dev/null || { echo "k6 is not installed (https://k6.io)"; exit 1; }

measure() {
  label="$1"
  disabled="$2"
  echo "=== $label (OTEL_SDK_DISABLED=$disabled)"
  OTEL_SDK_DISABLED="$disabled" docker compose up -d --wait --force-recreate api worker
  # Let the runtime warm up and the previous run's metrics window pass.
  sleep 15
  k6 run --quiet -e LABEL="$label" -e API_URL="$API_URL" -e RATE="$RATE" -e DURATION="$DURATION" scripts/overhead/k6.js
  # Resource use over the run, from the api's own process metrics.
  cpu=$(curl -sS "$PROMETHEUS_URL/api/v1/query" --data-urlencode "query=avg_over_time(rate(process_cpu_seconds_total{service=\"api\"}[15s])[$DURATION:5s])" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const r=JSON.parse(s).data.result[0];console.log(r?r.value[1]:"NaN")})')
  rss=$(curl -sS "$PROMETHEUS_URL/api/v1/query" --data-urlencode "query=max_over_time(process_resident_memory_bytes{service=\"api\"}[$DURATION])" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const r=JSON.parse(s).data.result[0];console.log(r?r.value[1]:"NaN")})')
  lag=$(curl -sS "$PROMETHEUS_URL/api/v1/query" --data-urlencode "query=max_over_time(nodejs_eventloop_lag_p99_seconds{service=\"api\"}[$DURATION])" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const r=JSON.parse(s).data.result[0];console.log(r?r.value[1]:"NaN")})')
  printf '{"label":"%s","otelSdkDisabled":%s,"cpuCoresAvg":%s,"rssMaxBytes":%s,"eventLoopLagP99MaxSeconds":%s,"rate":%s,"duration":"%s","node":"%s","date":"%s"}\n' \
    "$label" "$disabled" "$cpu" "$rss" "$lag" "$RATE" "$DURATION" "$(node --version)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$RESULTS/$label.process.json"
}

measure instrumented false
measure baseline true

# Leave the stack instrumented.
OTEL_SDK_DISABLED=false docker compose up -d --wait --force-recreate api worker
echo
echo "Results in $RESULTS/. Render the table with: npx tsx scripts/overhead/report.ts"
