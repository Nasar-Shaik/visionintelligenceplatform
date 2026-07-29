/**
 * Transport: delivery-log read + recipient ack. Permission-gated + tenant-scoped. `ack` is the
 * "with-ack" completion of the vertical: a recipient confirms receipt (`notification:ack`),
 * publishing `notification.acked`.
 */
import type { FastifyInstance } from 'fastify';
import { AckNotificationInput, NotificationQuery } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import type { NotificationService } from '../../application/notification-service.js';
import type { Auth } from '../plugins/auth.js';
import { parseBody, success } from '../http.js';

export interface NotificationRoutesDeps {
  service: NotificationService;
  auth: Auth;
}

interface NotificationParams {
  id: string;
}

interface RawQuery {
  incidentId?: string;
  status?: string;
  limit?: string;
  cursor?: string;
}

export function registerNotificationRoutes(
  app: FastifyInstance,
  deps: NotificationRoutesDeps,
): void {
  const { service, auth } = deps;
  const scopeOf = (tenantId: string): TenantScope => TenantScope.fromTenantId(tenantId);

  app.get(
    '/notifications',
    { preHandler: auth.authorize('notification:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const raw = request.query as RawQuery;
      const query = parseBody(NotificationQuery, {
        incidentId: raw.incidentId,
        status: raw.status,
        limit: raw.limit !== undefined ? Number(raw.limit) : undefined,
        cursor: raw.cursor,
      });
      return reply.send(success(await service.list(scope, query)));
    },
  );

  app.get<{ Params: NotificationParams }>(
    '/notifications/:id',
    { preHandler: auth.authorize('notification:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.get(scope, request.params.id)));
    },
  );

  app.post<{ Params: NotificationParams }>(
    '/notifications/:id/ack',
    { preHandler: auth.authorize('notification:ack') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const input = parseBody(AckNotificationInput, request.body ?? {});
      return reply.send(success(await service.ack(scope, request.params.id, input)));
    },
  );
}
