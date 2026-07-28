/**
 * Transport: liveness & readiness probes (docs/architecture/16).
 *   GET /health  liveness  — process is up; always 200.
 *   GET /ready   readiness — dependencies reachable; 200 when all checks pass, else 503.
 */
import type { FastifyInstance } from 'fastify';
import type { ReadinessRegistry } from '../../application/readiness.js';

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { readiness: ReadinessRegistry },
): void {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_request, reply) => {
    const report = await deps.readiness.run();
    reply.status(report.status === 'pass' ? 200 : 503);
    return report;
  });
}
