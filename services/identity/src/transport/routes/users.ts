/**
 * Transport: user management routes — the protected surface demonstrating authorization. Every
 * route is gated by a permission (`app.authorize(...)`, deny-by-default) and scoped to the
 * caller's tenant resolved from the access token, so a principal can only manage users in its
 * own tenant (isolation continues from P1-1).
 *
 * ### Why lifecycle is a route and not a field
 *
 * `PATCH /users/:id` changes roles. Disabling, re-enabling and resetting a password are separate
 * `POST`s, mirroring how a location is archived rather than `PATCH {status:'archived'}`. Each of
 * those three has a side effect the caller must not be able to trigger by accident — every one of
 * them ends the target's sessions — and each produces an audit line that names the act. `user.updated`
 * would not tell an auditor which of the four things happened.
 */
import type { FastifyInstance } from 'fastify';
import { CreateUserInput, SetUserPasswordInput, UpdateUserInput } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import type { UserService } from '../../application/user-service.js';
import type { Auth } from '../plugins/auth.js';
import { parseBody, success } from '../http.js';

export interface UserRoutesDeps {
  service: UserService;
  auth: Auth;
}

interface UserParams {
  id: string;
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

  app.get<{ Params: UserParams }>(
    '/users/:id',
    { preHandler: auth.authorize('user:read') },
    async (request, reply) => {
      const scope = TenantScope.fromTenantId(request.principal!.tenantId);
      return reply.send(success(await service.get(scope, request.params.id)));
    },
  );

  app.patch<{ Params: UserParams }>(
    '/users/:id',
    { preHandler: auth.authorize('user:update') },
    async (request, reply) => {
      const scope = TenantScope.fromTenantId(request.principal!.tenantId);
      const input = parseBody(UpdateUserInput, request.body);
      return reply.send(success(await service.update(scope, request.params.id, input)));
    },
  );

  /*
   * ⚠️ `user:update` rather than a new `user:disable`. A permission that exists can be granted, and
   * splitting "manage users" into finer grants would let a tenant hand out re-roling — which is the
   * ability to grant *any* role, including one's own — while withholding the far less dangerous
   * ability to disable. The finer split is the wrong way round, so it is not offered (§41).
   */
  app.post<{ Params: UserParams }>(
    '/users/:id/disable',
    { preHandler: auth.authorize('user:update') },
    async (request, reply) => {
      const principal = request.principal!;
      const scope = TenantScope.fromTenantId(principal.tenantId);
      const result = await service.disable(scope, request.params.id, principal.principalId);
      return reply.send(success(result));
    },
  );

  app.post<{ Params: UserParams }>(
    '/users/:id/enable',
    { preHandler: auth.authorize('user:update') },
    async (request, reply) => {
      const principal = request.principal!;
      const scope = TenantScope.fromTenantId(principal.tenantId);
      return reply.send(
        success(await service.enable(scope, request.params.id, principal.principalId)),
      );
    },
  );

  app.post<{ Params: UserParams }>(
    '/users/:id/password',
    { preHandler: auth.authorize('user:update') },
    async (request, reply) => {
      const principal = request.principal!;
      const scope = TenantScope.fromTenantId(principal.tenantId);
      const input = parseBody(SetUserPasswordInput, request.body);
      const result = await service.setPassword(
        scope,
        request.params.id,
        input.password,
        principal.principalId,
      );
      return reply.send(success(result));
    },
  );
}
