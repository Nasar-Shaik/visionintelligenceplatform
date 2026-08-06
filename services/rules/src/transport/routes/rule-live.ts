/**
 * Transport: **Live Rule Status** and **rule templates** (P-8 Phase 7).
 *
 * A third small plane beside authoring and operations, and separate for the reason those two are:
 * this one reads **live process state** rather than the store. It cannot be served by a node that is
 * not evaluating, and it says so with a `503` rather than reporting zeroes — the same posture
 * `RuleDiagnostics.cacheStats` already takes.
 *
 * ⚠️ `rule:read` throughout. The status page shows subject ids and zone names, which is the same
 * class of information the incident list already shows to the same people.
 */
import type { FastifyInstance } from 'fastify';
import { RULE_TEMPLATES } from '@vip/contracts';
import type { Auth } from '../plugins/auth.js';
import { success } from '../http.js';
import { scopeOf } from './rule-plane.js';
import type { RuleEngine } from '../../application/rule-engine.js';

export interface RuleLiveRoutesDeps {
  auth: Auth;
  /**
   * The evaluating engine on this node.
   *
   * ⚠️ A late-bound reference, not the engine itself: the server is built before the engine (it needs
   * the metrics registry), and this plane must not force that order to change. `undefined` means this
   * node does not evaluate — a real deployment shape, answered with a `503` rather than with zeroes.
   */
  engine: { current?: RuleEngine };
}

export function registerRuleLiveRoutes(app: FastifyInstance, deps: RuleLiveRoutesDeps): void {
  const { auth } = deps;

  /**
   * What the engine is doing right now (Architect recs 3 + 6).
   *
   * ⚠️ Includes the running dwell clocks — the loiter timers. This is the endpoint the browser
   * verification and the customer demonstration both read, and it is the only place an operator can
   * watch a threshold being approached rather than learn about it after the fact.
   */
  app.get('/rules/live', { preHandler: auth.authorize('rule:read') }, async (request, reply) => {
    const engine = deps.engine.current;
    if (engine === undefined) {
      /*
       * ⚠️ 503 with a reason, never an empty status object. A page rendering "0 active rules, 0
       * timers" for a node that does not evaluate is indistinguishable from a quiet estate, and one
       * of those is a deployment mistake somebody needs to find.
       */
      return reply.code(503).send({
        error: {
          code: 'not-evaluating',
          message: 'this node does not run the rule engine, so it has no live status to report',
        },
      });
    }
    const scope = scopeOf(request.principal!.tenantId);
    return reply.send(success(await engine.liveStatus(scope.tenantId)));
  });

  /**
   * Candidates a dry-run rule built and deliberately did not publish.
   *
   * ⚠️ The **same objects** a live rule would have raised, not summaries of them — see `DryRunLog`.
   * That is what makes a dry run worth running: what you see is what you would have got.
   */
  app.get(
    '/rules/live/dry-runs',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const engine = deps.engine.current;
      if (engine === undefined) {
        return reply.code(503).send({
          error: { code: 'not-evaluating', message: 'this node does not run the rule engine' },
        });
      }
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(engine.dryRuns.summaries(scope.tenantId)));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/rules/:id/dry-run-candidates',
    { preHandler: auth.authorize('rule:read') },
    async (request, reply) => {
      const engine = deps.engine.current;
      if (engine === undefined) {
        return reply.code(503).send({
          error: { code: 'not-evaluating', message: 'this node does not run the rule engine' },
        });
      }
      const tenantId = request.principal!.tenantId;
      /* ⚠️ Filtered by tenant here, not in the log — the log is cross-tenant like the engine. */
      const rows = engine.dryRuns
        .candidates(request.params.id)
        .filter((c) => c.tenantId === tenantId);
      return reply.send(success(rows));
    },
  );

  /**
   * The rule templates this platform ships.
   *
   * ⚠️ Compiled in, not stored — a template is a set of defaults over `CreateRuleInput` with no
   * behaviour, so there is nothing to persist and nothing that could drift between deployments. See
   * `packages/contracts/src/rules/templates.ts` for why there is exactly one.
   */
  app.get(
    '/rules/templates',
    { preHandler: auth.authorize('rule:read') },
    async (_request, reply) => reply.send(success(RULE_TEMPLATES)),
  );
}
