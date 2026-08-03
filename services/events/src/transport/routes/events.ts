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
import { notFound } from '../../application/errors.js';
import { parseBody, success } from '../http.js';

export interface EventRoutesDeps {
  service: EventQueryService;
  auth: Auth;
}

export function registerEventRoutes(app: FastifyInstance, deps: EventRoutesDeps): void {
  const { service, auth } = deps;
  const scopeOf = (tenantId: string): TenantScope => TenantScope.fromTenantId(tenantId);

  /**
   * Fetch one event by id (P-5.0 entry criterion G-5).
   *
   * The gap this closes: an incident carries `triggeredBy.eventId`, and until now nothing could
   * turn that id back into an event — `EventQuery` had no `id` filter and no by-id route existed.
   * That blocked the investigation workspace's flagship answer, _why did this rule fire_, which
   * needs the event to replay through `POST /rules/:id/simulate`.
   *
   * Additive only: `EventEnvelope` is a frozen AI Runtime v1.0 contract and is untouched. Another
   * tenant's event is a 404, identical to one that never existed (no existence leak).
   */
  app.get<{ Params: { id: string } }>(
    '/events/:id',
    { preHandler: auth.authorize('event:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const envelope = await service.getById(scope, request.params.id);
      if (!envelope) throw notFound(`event ${request.params.id} not found`);
      return reply.send(success(envelope));
    },
  );

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
