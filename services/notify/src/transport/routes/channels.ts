/**
 * Transport: notification-channel CRUD. Every route is permission-gated (deny-by-default) and scoped
 * to the caller's tenant from the validated access token — another tenant's channel is a 404. Bodies
 * are validated against @vip/contracts; per-type config (e.g. a webhook URL) is validated in the
 * service (400 on invalid).
 */
import type { FastifyInstance } from 'fastify';
import { CreateChannelInput, UpdateChannelInput } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import type { ChannelService } from '../../application/channel-service.js';
import type { Auth } from '../plugins/auth.js';
import { parseBody, success } from '../http.js';

export interface ChannelRoutesDeps {
  service: ChannelService;
  auth: Auth;
}

interface ChannelParams {
  id: string;
}

export function registerChannelRoutes(app: FastifyInstance, deps: ChannelRoutesDeps): void {
  const { service, auth } = deps;
  const scopeOf = (tenantId: string): TenantScope => TenantScope.fromTenantId(tenantId);

  app.post(
    '/notification-channels',
    { preHandler: auth.authorize('notification:create') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const input = parseBody(CreateChannelInput, request.body);
      return reply
        .status(201)
        .send(success(await service.create(scope, input, request.principal!.principalId)));
    },
  );

  app.get(
    '/notification-channels',
    { preHandler: auth.authorize('notification:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.list(scope)));
    },
  );

  app.get<{ Params: ChannelParams }>(
    '/notification-channels/:id',
    { preHandler: auth.authorize('notification:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.get(scope, request.params.id)));
    },
  );

  app.patch<{ Params: ChannelParams }>(
    '/notification-channels/:id',
    { preHandler: auth.authorize('notification:update') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const patch = parseBody(UpdateChannelInput, request.body);
      return reply.send(
        success(
          await service.update(scope, request.params.id, patch, request.principal!.principalId),
        ),
      );
    },
  );

  app.delete<{ Params: ChannelParams }>(
    '/notification-channels/:id',
    { preHandler: auth.authorize('notification:delete') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      await service.remove(scope, request.params.id);
      return reply.status(204).send();
    },
  );
}
