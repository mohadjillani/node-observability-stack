#!/usr/bin/env sh
# Traffic that makes the stack show something: normal orders, slow orders
# (SLOW-* skus add 1.5 s to the pricing hop), orders whose pricing fails
# (FAIL-* skus: the worker's job fails and is retried three times), plus
# some 400s and 404s. Run it against the compose stack, then look at the
# dashboards (README, "What to look at").
#
#   ./scripts/break-it.sh                 # one round
#   ROUNDS=20 ./scripts/break-it.sh       # keep going
#   API_URL=http://api:3000 ./scripts/break-it.sh
set -eu

API_URL="${API_URL:-http://localhost:3000}"
ROUNDS="${ROUNDS:-5}"
PAUSE="${PAUSE:-1}"

post_order() {
  curl -sS -o /dev/null -w "POST /orders %{http_code} sku=$1\n" \
    -X POST "$API_URL/orders" -H 'content-type: application/json' \
    -d "{\"sku\":\"$1\",\"quantity\":$2}"
}

echo "api: $API_URL — $ROUNDS round(s)"
curl -sSf "$API_URL/readyz" >/dev/null || { echo "api is not ready"; exit 1; }

round=0
while [ "$round" -lt "$ROUNDS" ]; do
  round=$((round + 1))
  echo "--- round $round"

  # The normal path: cheap, fast, mostly sampled out by the baseline policy.
  for i in 1 2 3 4 5 6; do post_order "SKU-$((RANDOM % 20))" "$((RANDOM % 5 + 1))"; done

  # Slow: above the 500 ms tail-sampling latency policy and the p95 alert.
  post_order "SLOW-$((RANDOM % 5))" 2

  # Failing: the pricing hop answers 503, the job fails, BullMQ retries with backoff.
  post_order "FAIL-$((RANDOM % 5))" 1

  # Client errors and an unmatched route: counted under their templates / 'unmatched'.
  curl -sS -o /dev/null -w "POST /orders %{http_code} (invalid body)\n" \
    -X POST "$API_URL/orders" -H 'content-type: application/json' -d '{"sku":"","quantity":0}'
  curl -sS -o /dev/null -w "GET /orders/not-a-uuid %{http_code}\n" "$API_URL/orders/not-a-uuid"
  curl -sS -o /dev/null -w "GET /nope/$$ %{http_code}\n" "$API_URL/nope/$$"

  sleep "$PAUSE"
done

echo
echo "Now open:"
echo "  http://localhost:3001/d/nos-red        RED — the 5xx and the slow p95"
echo "  http://localhost:3001/d/nos-queues     failed jobs, retries, depth"
echo "  http://localhost:3001/d/nos-drilldown  exemplar → trace → logs"
