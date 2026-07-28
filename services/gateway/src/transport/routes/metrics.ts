/**
 * Transport: Prometheus scrape endpoint. GET /metrics returns the per-instance registry
 * in text exposition format. Unauthenticated by convention — scraping is restricted at
 * the network layer, and no tenant data is exposed here.
 */
import type { FastifyInstance } from 'fastify';
import type { Registry } from 'prom-client';

export function registerMetricsRoute(app: FastifyInstance, registry: Registry): void {
  app.get('/metrics', async (_request, reply) => {
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });
}
