/**
 * Transport: user management routes — the protected surface demonstrating authorization. Both
 * routes are gated by a permission (`app.authorize(...)`, deny-by-default) and scoped to the
 * caller's tenant resolved from the access token, so a principal can only manage users in its
 * own tenant (isolation continues from P1-1).
 */
import type { FastifyInstance } from 'fastify';
import { CreateUserInput } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import type { UserService } from '../../application/user-service.js';
import type { Auth } from '../plugins/auth.js';
import { parseBody, success } from '../http.js';

export interface UserRoutesDeps {
  service: UserService;
  auth: Auth;
}

export function registerUserRoutes(app: FastifyInstance, deps: UserRoutesDeps): void {
  const { service, auth } = deps;

  app.post('/users', { preHandler: auth.authorize('user:create') }, async (request, reply) => {
    const scope = TenantScope.fromTenantId(request.principal!.tenantId);
    const input = parseBody(CreateUserInput, request.body);
    return reply.status(201).send(success(await service.create(scope, input)));
  });

  app.get('/users', { preHandler: auth.authorize('user:read') }, async (request, reply) => {
    const scope = TenantScope.fromTenantId(request.principal!.tenantId);
    return reply.send(success(await service.list(scope)));
  });
}
