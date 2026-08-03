/**
 * Transport: the **authoring plane** (P-4.2, Architect rec 9).
 *
 * The routes an author uses to make a rule and change it: create, read, edit, delete, rollback,
 * validate, dry-run, simulate. Everything here either writes a rule or answers a question about one
 * an author is in the middle of writing.
 *
 * The platform has three planes, and they are worth naming because they have different consumers,
 * different permissions and different reasons to change:
 *
 * | Plane         | Who calls it            | Where it lives                          |
 * | ------------- | ----------------------- | --------------------------------------- |
 * | **Authoring** | the console, an admin   | this file                               |
 * | **Operations**| support, ops, P-5       | `rule-operations.ts`                     |
 * | **Runtime**   | nothing — it is a bus consumer | `application/rule-engine.ts`      |
 *
 * ⚠️ **The paths are unchanged.** The separation is structural, not a URL rewrite: renaming published
 * routes breaks every consumer and every integration in exchange for tidier prose, which
 * [CONSTRAINTS §41](../../../../docs/project/CONSTRAINTS.md) forbids for exactly that trade. If the
 * planes ever need separate prefixes, that is an ADR with a migration path.
 *
 * Every route is permission-gated (deny-by-default via @vip/permissions) and scoped to the caller's
 * tenant from the validated access token — a rule in another tenant is a 404, never a 403, because a
 * 403 confirms it exists. Bodies are validated against @vip/contracts. The actor is recorded in the
 * audit trail.
 */
import type { FastifyInstance } from 'fastify';
import {
  CreateRuleInput,
  RuleDryRunInput,
  RuleRollbackInput,
  RuleSimulationInput,
  UpdateRuleInput,
} from '@vip/contracts';
import type { RuleService } from '../../application/rule-service.js';
import type { Auth } from '../plugins/auth.js';
import { parseBody, success } from '../http.js';
import { guardNesting, scopeOf, type RuleParams } from './rule-plane.js';

export interface RuleAuthoringDeps {
  service: RuleService;
  auth: Auth;
}

export function registerRuleAuthoringRoutes(app: FastifyInstance, deps: RuleAuthoringDeps): void {
  const { service, auth } = deps;

  app.post('/rules', { preHandler: auth.authorize('rule:create') }, async (request, reply) => {
    const scope = scopeOf(request.principal!.tenantId);
    guardNesting(request.body);
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

  /*
   * Validate a rule's references (P-4). A **GET**: it reads and reports, changes no lifecycle and
   * writes nothing, so it is safe to poll from an editor and safe to retry.
   */
  app.get<{ Params: RuleParams }>(
    '/rules/:id/validation',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.validate(scope, request.params.id)));
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

  /**
   * Run a rule against supplied events (P-4.1, Architect rec 9). Read-only: nothing is emitted, no
   * state is touched. Replay over stored history returns 501 — see `simulate`.
   */
  app.post<{ Params: RuleParams }>(
    '/rules/:id/simulate',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const input = parseBody(RuleSimulationInput, request.body);
      return reply.send(success(await service.simulate(scope, request.params.id, input)));
    },
  );

  /**
   * Restore an earlier version's content as a new version (P-4.1, Architect rec 7).
   *
   * A **POST**, because it creates a version. `rule:update` rather than a permission of its own — it
   * is an edit, and inventing a separate one would let a role edit rules but not undo an edit.
   */
  app.post<{ Params: RuleParams }>(
    '/rules/:id/rollback',
    { preHandler: auth.authorize('rule:update') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const { version } = parseBody(RuleRollbackInput, request.body);
      return reply.send(
        success(
          await service.rollback(scope, request.params.id, version, request.principal!.principalId),
        ),
      );
    },
  );

  app.patch<{ Params: RuleParams }>(
    '/rules/:id',
    { preHandler: auth.authorize('rule:update') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      guardNesting(request.body);
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
