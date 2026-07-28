/**
 * Transport: tenant + org-hierarchy HTTP routes. Public bodies are validated against the
 * @vip/contracts schemas (contract-first). Every tenant-scoped route resolves a TenantScope
 * from the request's tenant context and refuses a path that addresses a different tenant —
 * the endpoint-level fail-closed isolation gate (P1-1 acceptance).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CreateOrgNodeInput, CreateTenantInput, UpdateTenantInput } from '@vip/contracts';
import { TenancyError, TenantScope } from '@vip/tenancy';
import type { TenantService } from '../../application/tenant-service.js';
import { AppError, badRequest } from '../../application/errors.js';
import type { z } from 'zod';

export interface TenantRoutesDeps {
  service: TenantService;
}

interface TenantParams {
  tenantId: string;
}

function success<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

/** Parse a body against a contract schema, or fail with a 400 carrying field details. */
function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    throw badRequest(
      first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'invalid body',
    );
  }
  return result.data;
}

/**
 * Resolve the scope for a tenant-addressed route. Requires a tenant context and refuses any
 * attempt to act on a tenant other than the caller's (cross-tenant → 403, fail-closed).
 */
function scopeFor(request: FastifyRequest, pathTenantId: string): TenantScope {
  const ctx = request.tenantContext;
  if (!ctx) throw new AppError(401, 'unauthenticated', 'a tenant context is required');
  if (ctx.tenantId !== pathTenantId) {
    throw new TenancyError('cross-tenant access is not permitted');
  }
  return TenantScope.fromContext(ctx);
}

export function registerTenantRoutes(app: FastifyInstance, deps: TenantRoutesDeps): void {
  const { service } = deps;

  // Provision a tenant (control-plane; authz added in P1-2).
  app.post('/tenants', async (request, reply) => {
    const input = parse(CreateTenantInput, request.body);
    const result = await service.provision(input);
    return reply.status(201).send(success(result));
  });

  // Get the caller's tenant.
  app.get<{ Params: TenantParams }>('/tenants/:tenantId', async (request, reply) => {
    const scope = scopeFor(request, request.params.tenantId);
    return reply.send(success(await service.get(scope)));
  });

  // Update the caller's tenant (name and/or lifecycle transition).
  app.patch<{ Params: TenantParams }>('/tenants/:tenantId', async (request, reply) => {
    const scope = scopeFor(request, request.params.tenantId);
    const patch = parse(UpdateTenantInput, request.body);
    return reply.send(success(await service.update(scope, patch)));
  });

  // List the caller's org-hierarchy nodes.
  app.get<{ Params: TenantParams }>('/tenants/:tenantId/org-nodes', async (request, reply) => {
    const scope = scopeFor(request, request.params.tenantId);
    return reply.send(success(await service.listOrgNodes(scope)));
  });

  // Create an org-hierarchy node under the caller's tenant.
  app.post<{ Params: TenantParams }>('/tenants/:tenantId/org-nodes', async (request, reply) => {
    const scope = scopeFor(request, request.params.tenantId);
    const input = parse(CreateOrgNodeInput, request.body);
    return reply.status(201).send(success(await service.createOrgNode(scope, input)));
  });
}
