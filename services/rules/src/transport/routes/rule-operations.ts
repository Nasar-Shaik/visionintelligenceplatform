/**
 * Transport: the **operations plane** (P-4.2, Architect rec 9).
 *
 * The routes support, operations and P-5 call: what is this rule, what does it point at, is any of it
 * broken, what has it been doing, and what changed. Nothing here writes a rule — the only non-`GET` is
 * an import, which creates them and is gated accordingly.
 *
 * Everything is **derived on demand**: there is no diagnostics store, and the absence of one is the
 * design ([ADR-0027](../../../../docs/adr/ADR-0027-rule-operations-diagnostics-and-portability.md)).
 * That makes every route here safe to poll, safe to retry, and incapable of disagreeing with the rule
 * it describes.
 *
 * ⚠️ Paths are unchanged from before the split — see `rule-authoring.ts` for why renaming them is not
 * on the table.
 */
import type { FastifyInstance } from 'fastify';
import {
  RuleDiagnosticQuery,
  RuleImportConflictPolicy,
  RuleLifecycleState,
  RulePackage,
  RuleReferenceKind,
} from '@vip/contracts';
import { badRequest } from '../../application/errors.js';
import type { RuleService } from '../../application/rule-service.js';
import type { Auth } from '../plugins/auth.js';
import { parseBody, success } from '../http.js';
import { guardNesting, scopeOf, type RuleParams } from './rule-plane.js';

export interface RuleOperationsDeps {
  service: RuleService;
  auth: Auth;
}

interface DiffQuery {
  from?: string;
  to?: string;
}

/** A positive integer from a query string, or `undefined` — never `NaN` leaking into a lookup. */
function asVersion(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function registerRuleOperationsRoutes(app: FastifyInstance, deps: RuleOperationsDeps): void {
  const { service, auth } = deps;

  /*
   * Static paths first for readability; Fastify's radix tree prefers a static segment over a
   * parameter regardless of registration order, so `/rules/stats` is never read as a rule id.
   */

  /** Which rules depend on one thing — "is this safe to delete?" (P-4.1, Architect rec 2). */
  app.get<{ Querystring: { kind?: string; ref?: string } }>(
    '/rules/dependents',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const kind = RuleReferenceKind.safeParse(request.query.kind);
      if (!kind.success) {
        throw badRequest(`kind must be one of ${RuleReferenceKind.options.join(', ')}`);
      }
      const ref = request.query.ref;
      if (!ref) throw badRequest('ref is required — the id of the thing to look up');
      return reply.send(success(await service.dependents(scope, kind.data, ref)));
    },
  );

  /**
   * Filter a tenant's rules by what is wrong with them (P-4.2, Architect rec 13).
   *
   * Returns rows, not packages: building the full artifact per rule to render a list is the obvious
   * mistake, and at a few hundred rules it is a few hundred cross-context calls.
   */
  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/rules/diagnostics',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      // Parsed rather than trusted: an unknown lifecycle in a query string is a 400, not silence.
      const query = RuleDiagnosticQuery.safeParse(request.query);
      if (!query.success) {
        throw badRequest(
          `unrecognised filter: ${query.error.issues[0]?.path.join('.') ?? 'unknown'}. lifecycle must be one of ${RuleLifecycleState.options.join(', ')}`,
        );
      }
      return reply.send(success(await service.searchDiagnostics(scope, query.data)));
    },
  );

  /** Runtime statistics for this tenant on this node (P-4.1, Architect recs 3 + 8). */
  app.get('/rules/stats', { preHandler: auth.authorize('rule:read') }, async (request, reply) => {
    const scope = scopeOf(request.principal!.tenantId);
    return reply.send(success(service.stats(scope)));
  });

  /** Export this tenant's rules as a portable package (P-4.1, Architect rec 10). */
  app.get('/rules/export', { preHandler: auth.authorize('rule:read') }, async (request, reply) => {
    const scope = scopeOf(request.principal!.tenantId);
    return reply.send(success(await service.exportRules(scope)));
  });

  /**
   * Import a package (P-4.1, Architect rec 10). Everything lands as a **draft**, and an incompatible
   * package imports nothing at all (P-4.2, rec 11).
   *
   * Gated on `rule:create`, not `rule:read`: an import creates rules, and the permission must say so.
   */
  app.post<{ Querystring: { onConflict?: string } }>(
    '/rules/import',
    { preHandler: auth.authorize('rule:create') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      guardNesting(request.body);
      /*
       * The body stays a bare `RulePackage` — the shape P-4.1 published — and the conflict policy
       * arrives as a query parameter. Wrapping the body would have been tidier and would have broken
       * every existing caller for the sake of it (CONSTRAINTS §41).
       */
      const pkg = parseBody(RulePackage, request.body);
      const onConflict = RuleImportConflictPolicy.safeParse(request.query.onConflict ?? 'skip');
      if (!onConflict.success) {
        throw badRequest(
          `onConflict must be one of ${RuleImportConflictPolicy.options.join(', ')}`,
        );
      }
      return reply.send(
        success(
          await service.importRules(
            scope,
            { package: pkg, onConflict: onConflict.data },
            request.principal!.principalId,
          ),
        ),
      );
    },
  );

  /** The rule's lifecycle timeline, derived from its versions (P-4.1, Architect rec 12). */
  app.get<{ Params: RuleParams }>(
    '/rules/:id/audit',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.audit(scope, request.params.id)));
    },
  );

  /**
   * What this rule points at (P-4.1, Architect rec 2), optionally with whether it is there (P-4.2,
   * rec 4).
   *
   * `?status=true` is opt-in because checking calls other contexts. A caller that does not ask gets
   * `statusChecked: false` rather than an implied all-clear.
   */
  app.get<{ Params: RuleParams; Querystring: { status?: string } }>(
    '/rules/:id/dependencies',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const checkStatus = request.query.status === 'true';
      return reply.send(
        success(await service.dependencies(scope, request.params.id, { checkStatus })),
      );
    },
  );

  /** Fingerprints for this rule version (P-4.1, Architect recs 1 + 14). */
  app.get<{ Params: RuleParams }>(
    '/rules/:id/compilation',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.compilation(scope, request.params.id)));
    },
  );

  /** How much rule there is, relative to what this deployment allows (P-4.2, Architect rec 3). */
  app.get<{ Params: RuleParams }>(
    '/rules/:id/complexity',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.complexity(scope, request.params.id)));
    },
  );

  /** Whether the rule is in good shape, with every deduction named (P-4.2, Architect rec 2). */
  app.get<{ Params: RuleParams }>(
    '/rules/:id/health',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.health(scope, request.params.id)));
    },
  );

  /** What changed between two versions (P-4.2, Architect rec 6). */
  app.get<{ Params: RuleParams; Querystring: DiffQuery }>(
    '/rules/:id/diff',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const from = asVersion(request.query.from);
      const to = asVersion(request.query.to);
      if (from === undefined || to === undefined) {
        throw badRequest('from and to are required, and both must be version numbers');
      }
      return reply.send(success(await service.diff(scope, request.params.id, from, to)));
    },
  );

  /** **The support artifact** — everything about one rule in one response (P-4.2, recs 1 + 14). */
  app.get<{ Params: RuleParams }>(
    '/rules/:id/diagnostics',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.diagnosticPackage(scope, request.params.id)));
    },
  );

  /**
   * **The contract Incident Management consumes** (P-4.2, Architect recs 12 + 15).
   *
   * `?version=` asks for the version an incident was raised by. Without it the answer describes the
   * rule as it stands, which is the right default for "show me this rule" and the wrong one for
   * "explain this incident" — hence the parameter rather than an assumption.
   */
  app.get<{ Params: RuleParams; Querystring: { version?: string } }>(
    '/rules/:id/incident-context',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const version = asVersion(request.query.version);
      if (request.query.version !== undefined && version === undefined) {
        throw badRequest('version must be a positive integer');
      }
      return reply.send(success(await service.incidentContext(scope, request.params.id, version)));
    },
  );
}
