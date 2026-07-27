/**
 * Transport: service root. GET / returns a service-info snapshot wrapped in the public
 * API success envelope (docs/architecture/21 §1). Exercises the full call direction
 * transport → application → domain without any business logic.
 */
import type { FastifyInstance } from 'fastify';
import { getServiceInfo } from '../../application/get-service-info.js';

export function registerRootRoute(
  app: FastifyInstance,
  deps: { name: string; version: string; startedAt: Date },
): void {
  app.get('/', async () => {
    const info = getServiceInfo(deps);
    return { success: true as const, data: info };
  });
}
