/**
 * Transport: event read + replay routes. Both are permission-gated (deny-by-default via
 * @vip/permissions) and scoped to the caller's tenant resolved from the validated access token —
 * a query can never widen across tenants (Law 5). `GET /events` is a bounded, cursor-paged read;
 * `POST /events/replay` re-publishes a bounded window (admin) onto the backbone. Inputs are
 * validated against @vip/contracts (contract-first).
 */
import type { FastifyInstance } from 'fastify';
import { EventQuery, EventReplayRequest } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import type { EventQueryService } from '../../application/event-query-service.js';
import type { Auth } from '../plugins/auth.js';
import { parseBody, success } from '../http.js';

export interface EventRoutesDeps {
  service: EventQueryService;
  auth: Auth;
}

export function registerEventRoutes(app: FastifyInstance, deps: EventRoutesDeps): void {
  const { service, auth } = deps;
  const scopeOf = (tenantId: string): TenantScope => TenantScope.fromTenantId(tenantId);

  app.get('/events', { preHandler: auth.authorize('event:read') }, async (request, reply) => {
    const scope = scopeOf(request.principal!.tenantId);
    const raw = { ...(request.query as Record<string, unknown>) };
    if (raw['limit'] !== undefined) raw['limit'] = Number(raw['limit']);
    const query = parseBody(EventQuery, raw);
    return reply.send(success(await service.query(scope, query)));
  });

  app.post(
    '/events/replay',
    { preHandler: auth.authorize('event:replay') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const req = parseBody(EventReplayRequest, request.body);
      return reply.send(success(await service.replay(scope, req)));
    },
  );
}
