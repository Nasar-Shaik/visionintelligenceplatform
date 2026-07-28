/**
 * Transport: authentication routes. `/auth/login` authenticates within a tenant (the tenant is
 * named by the `x-tenant-id` header — the gateway/subdomain supplies it; it scopes the user
 * lookup, it is not a privilege claim). `/auth/refresh` rotates tokens with reuse-detection.
 * `/auth/me` returns the principal resolved from the access token.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { LoginInput, RefreshInput } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import type { AuthService } from '../../application/auth-service.js';
import type { Auth } from '../plugins/auth.js';
import { AppError } from '../../application/errors.js';
import { parseBody, success } from '../http.js';

export interface AuthRoutesDeps {
  service: AuthService;
  auth: Auth;
}

function loginScope(request: FastifyRequest): TenantScope {
  const tenantId = request.headers['x-tenant-id'];
  if (typeof tenantId !== 'string' || tenantId.trim() === '') {
    throw new AppError(400, 'bad_request', 'x-tenant-id header is required to log in');
  }
  return TenantScope.fromTenantId(tenantId);
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): void {
  const { service, auth } = deps;

  app.post('/auth/login', async (request, reply) => {
    const scope = loginScope(request);
    const input = parseBody(LoginInput, request.body);
    return reply.send(success(await service.login(scope, input)));
  });

  app.post('/auth/refresh', async (request, reply) => {
    const { refreshToken } = parseBody(RefreshInput, request.body);
    return reply.send(success(await service.refresh(refreshToken)));
  });

  app.post('/auth/logout', async (request, reply) => {
    const { refreshToken } = parseBody(RefreshInput, request.body);
    await service.logout(refreshToken);
    return reply.status(204).send();
  });

  app.get('/auth/me', { preHandler: auth.authenticate }, async (request, reply) => {
    const p = request.principal!;
    // Roles are authoritative; effective grants are evaluated server-side by @vip/permissions.
    return reply.send(
      success({
        principalId: p.principalId,
        tenantId: p.tenantId,
        email: p.email,
        roles: p.roles,
        permissions: [],
        scopes: [],
      }),
    );
  });
}
