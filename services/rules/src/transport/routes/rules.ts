/**
 * Transport: rule authoring + dry-run routes. Every route is permission-gated (deny-by-default via
 * @vip/permissions) and scoped to the caller's tenant from the validated access token — a rule in
 * another tenant is a 404 (no existence leak). Bodies are validated against @vip/contracts
 * (contract-first). Dry-run is read-only (no emission, no state). The actor (principal id) is
 * recorded in the audit trail.
 */
import type { FastifyInstance } from 'fastify';
import {
  CreateRuleInput,
  RuleDryRunInput,
  RulePackage,
  RuleReferenceKind,
  RuleRollbackInput,
  RuleSimulationInput,
  UpdateRuleInput,
} from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import { MAX_BODY_NESTING, rawDepth } from '../../domain/budget.js';
import { badRequest } from '../../application/errors.js';
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

/**
 * Refuse an absurdly nested body **before** it reaches the schema (P-4.1).
 *
 * `RuleCondition` is a recursive Zod schema, so a deeply nested body overflows the stack inside the
 * parser — before validation, before the budget check, before anything can report it. The precise
 * limit is enforced afterwards by `budgetChecks` with a number that means something to an author;
 * this is only the crash guard, and it has to run first.
 */
function guardNesting(body: unknown): void {
  if (rawDepth(body, MAX_BODY_NESTING) > MAX_BODY_NESTING) {
    throw badRequest('this request is nested too deeply to be a rule');
  }
}

export function registerRuleRoutes(app: FastifyInstance, deps: RuleRoutesDeps): void {
  const { service, auth } = deps;
  const scopeOf = (tenantId: string): TenantScope => TenantScope.fromTenantId(tenantId);

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

  /*
   * P-4.1 diagnostics. All **GET**s under `rule:read`: they compute and report, write nothing, and are
   * safe to poll from a console or a support session.
   */

  /** The rule's lifecycle timeline, derived from its versions (Architect rec 12). */
  app.get<{ Params: RuleParams }>(
    '/rules/:id/audit',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.audit(scope, request.params.id)));
    },
  );

  /** What this rule points at (Architect rec 2). */
  app.get<{ Params: RuleParams }>(
    '/rules/:id/dependencies',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.dependencies(scope, request.params.id)));
    },
  );

  /** Fingerprints for this rule version (Architect recs 1 + 14). */
  app.get<{ Params: RuleParams }>(
    '/rules/:id/compilation',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.compilation(scope, request.params.id)));
    },
  );

  /**
   * Which rules depend on one thing — "is this safe to delete?" (Architect rec 2).
   *
   * Registered **before** `/rules/:id` would be a concern in a router that matched greedily; Fastify's
   * radix tree prefers the static segment, so `/rules/dependents` is not read as a rule id.
   */
  app.get<{ Querystring: { kind?: string; ref?: string } }>(
    '/rules/dependents',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const kind = RuleReferenceKind.safeParse(request.query.kind);
      if (!kind.success)
        throw badRequest(`kind must be one of ${RuleReferenceKind.options.join(', ')}`);
      const ref = request.query.ref;
      if (!ref) throw badRequest('ref is required — the id of the thing to look up');
      return reply.send(success(await service.dependents(scope, kind.data, ref)));
    },
  );

  /** Runtime statistics for this tenant on this node (Architect recs 3 + 8). */
  app.get('/rules/stats', { preHandler: auth.authorize('rule:read') }, async (request, reply) => {
    const scope = scopeOf(request.principal!.tenantId);
    return reply.send(success(service.stats(scope)));
  });

  /** Export this tenant's rules as a portable package (Architect rec 10). */
  app.get('/rules/export', { preHandler: auth.authorize('rule:read') }, async (request, reply) => {
    const scope = scopeOf(request.principal!.tenantId);
    return reply.send(success(await service.exportRules(scope)));
  });

  /**
   * Import a package (Architect rec 10). Everything lands as a **draft** — see `importRules`.
   *
   * Gated on `rule:create`, not `rule:read`: an import creates rules, and the permission has to say so.
   */
  app.post(
    '/rules/import',
    { preHandler: auth.authorize('rule:create') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      guardNesting(request.body);
      const pkg = parseBody(RulePackage, request.body);
      return reply.send(
        success(await service.importRules(scope, pkg, request.principal!.principalId)),
      );
    },
  );

  /**
   * Run a rule against supplied events (Architect rec 9). Read-only: nothing is emitted, no state
   * is touched. Replay over stored history returns 501 — see `simulate`.
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
   * Restore an earlier version's content as a new version (Architect rec 7).
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
