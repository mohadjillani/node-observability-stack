import { createServer, type Server } from 'node:http';
import type { Metrics } from '@mohadjillani/telemetry';

/**
 * The worker has no API, but it does need to be scraped. A bare http server
 * with `/metrics` and `/healthz` is enough; it stays out of the traces
 * (those paths are ignored by the http instrumentation).
 */
export function startMetricsServer(
  metrics: Metrics,
  port: number,
  host = '0.0.0.0',
): Promise<Server> {
  const handler = metrics.handler();
  const server = createServer((request, response) => {
    const path = request.url?.split('?')[0];
    if (path === '/metrics') {
      handler(request, response).catch((error: unknown) => {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : 'metrics failed');
      });
      return;
    }
    if (path === '/healthz') {
      response.setHeader('content-type', 'application/json');
      response.end('{"status":"ok"}');
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
