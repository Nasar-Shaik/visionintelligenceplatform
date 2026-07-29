/**
 * Transport plugin: Prometheus metrics (docs/architecture/16). Uses a per-instance registry
 * (not the global default) so multiple app instances — notably in tests — never collide on
 * "metric already registered". Records default process metrics plus an HTTP request-duration
 * histogram, and returns the registry for the /metrics route.
 */
import type { FastifyInstance } from 'fastify';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

const METRICS_ROUTE = '/metrics';

export function registerMetrics(app: FastifyInstance, opts: { serviceName: string }): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service: opts.serviceName });
  collectDefaultMetrics({ register: registry });

  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url ?? 'unknown';
    if (route !== METRICS_ROUTE) {
      httpDuration.observe(
        { method: request.method, route, status_code: reply.statusCode },
        reply.elapsedTime / 1000,
      );
    }
    done();
  });

  return registry;
}
