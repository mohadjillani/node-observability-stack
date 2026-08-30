// k6 script for the overhead measurement. Same load, two runs: with the SDK
// and with OTEL_SDK_DISABLED=true. See scripts/overhead/run.sh.
//
//   k6 run -e LABEL=instrumented -e API_URL=http://localhost:3000 scripts/overhead/k6.js
import http from 'k6/http';
import { check } from 'k6';

const API_URL = __ENV.API_URL || 'http://localhost:3000';
const LABEL = __ENV.LABEL || 'run';
const RATE = Number(__ENV.RATE || 100); // requests per second
const DURATION = __ENV.DURATION || '60s';

export const options = {
  scenarios: {
    orders: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 20,
      maxVUs: 200,
    },
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  // Mostly writes (the traced path with the queue hop), some reads.
  const create = http.post(
    `${API_URL}/orders`,
    JSON.stringify({ sku: `SKU-${__VU % 20}`, quantity: 1 + (__ITER % 3) }),
    { headers: { 'content-type': 'application/json' }, tags: { route: '/orders' } },
  );
  check(create, { 'order accepted': (r) => r.status === 202 });
  if (create.status === 202 && __ITER % 4 === 0) {
    const { id } = create.json();
    http.get(`${API_URL}/orders/${id}`, { tags: { route: '/orders/:id' } });
  }
}

export function handleSummary(data) {
  return { [`scripts/overhead/results/${LABEL}.k6.json`]: JSON.stringify(data, null, 2) };
}
