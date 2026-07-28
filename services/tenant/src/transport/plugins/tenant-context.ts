/**
 * Transport plugin: tenant-context resolution (Law 5 — every operation is tenant-scoped;
 * docs/architecture/06 §2). In this Phase 0 scaffold there is no authentication yet, so
 * this only *demonstrates the seam*: it validates any inbound `x-tenant-id` /
 * `x-principal-id` headers against the `TenantContext` contract and attaches the result.
 * It does NOT yet enforce presence — enforcement arrives with the auth middleware in P1
 * (identity is the service that will mint that context). Business routes must not trust
 * `request.tenantContext` until then.
 */
import type { FastifyInstance } from 'fastify';
import { TenantContext } from '@vip/contracts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved tenant context, or null when unauthenticated (all Phase 0 requests). */
    tenantContext: TenantContext | null;
  }
}

export function registerTenantContext(app: FastifyInstance): void {
  app.decorateRequest('tenantContext', null);

  app.addHook('onRequest', (request, _reply, done) => {
    const tenantId = request.headers['x-tenant-id'];
    const principalId = request.headers['x-principal-id'];
    if (typeof tenantId === 'string' && typeof principalId === 'string') {
      const parsed = TenantContext.safeParse({ tenantId, principalId });
      if (parsed.success) request.tenantContext = parsed.data;
    }
    done();
  });
}
