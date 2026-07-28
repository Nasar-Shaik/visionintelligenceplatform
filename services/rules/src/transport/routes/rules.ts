/**
 * Transport: rule authoring + dry-run routes. Every route is permission-gated (deny-by-default via
 * @vip/permissions) and scoped to the caller's tenant from the validated access token — a rule in
 * another tenant is a 404 (no existence leak). Bodies are validated against @vip/contracts
 * (contract-first). Dry-run is read-only (no emission, no state). The actor (principal id) is
 * recorded in the audit trail.
 */
import type { FastifyInstance } from 'fastify';
import { CreateRuleInput, RuleDryRunInput, UpdateRuleInput } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import type { RuleService } from '../../application/rule-service.js';
import type { Auth } from '../plugins/auth.js';
import { parseBody, success } from '../http.js';

export interface RuleRoutesDeps {
  service: RuleService;
  auth: Auth;
}

interface RuleParams {
  id: string;
}

export function registerRuleRoutes(app: FastifyInstance, deps: RuleRoutesDeps): void {
  const { service, auth } = deps;
  const scopeOf = (tenantId: string): TenantScope => TenantScope.fromTenantId(tenantId);

  app.post('/rules', { preHandler: auth.authorize('rule:create') }, async (request, reply) => {
    const scope = scopeOf(request.principal!.tenantId);
    const input = parseBody(CreateRuleInput, request.body);
    return reply
      .status(201)
      .send(success(await service.create(scope, input, request.principal!.principalId)));
  });

  app.get('/rules', { preHandler: auth.authorize('rule:read') }, async (request, reply) => {
    const scope = scopeOf(request.principal!.tenantId);
    return reply.send(success(await service.list(scope)));
  });

  app.get<{ Params: RuleParams }>(
    '/rules/:id',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.get(scope, request.params.id)));
    },
  );

  app.get<{ Params: RuleParams }>(
    '/rules/:id/versions',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.listVersions(scope, request.params.id)));
    },
  );

  app.post<{ Params: RuleParams }>(
    '/rules/:id/dry-run',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const { event } = parseBody(RuleDryRunInput, request.body);
      return reply.send(success(await service.dryRun(scope, request.params.id, event)));
    },
  );

  app.patch<{ Params: RuleParams }>(
    '/rules/:id',
    { preHandler: auth.authorize('rule:update') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const patch = parseBody(UpdateRuleInput, request.body);
      return reply.send(
        success(
          await service.update(scope, request.params.id, patch, request.principal!.principalId),
        ),
      );
    },
  );

  app.delete<{ Params: RuleParams }>(
    '/rules/:id',
    { preHandler: auth.authorize('rule:delete') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      await service.remove(scope, request.params.id, request.principal!.principalId);
      return reply.status(204).send();
    },
  );
}
