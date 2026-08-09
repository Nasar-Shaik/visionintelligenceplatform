/**
 * Transport: **reasoning over the behaviour graph** (Phase 2.4 slice 2.7).
 *
 *   POST /rules/behaviour/evaluate   { streamId | cameraId, rules: BehaviourRule[] }
 *
 * ⭐ **A fourth plane, and separate for the reason the other three are:** it reads neither the store
 * nor live process state, but a *projection of perception* fetched from media. It is the one place
 * in this service that asks another service a question in order to answer one.
 *
 * ### ⛔ Why rules and not the runtime
 *
 * The graph is geometry: who was where, near whom, holding what. Deciding that a particular sequence
 * of geometry is worth a person's attention is a judgement, and [ADR-0052] puts judgements outside
 * perception. Evaluating here keeps the runtime free of every domain word, and keeps the *only*
 * place an intent may be named — `candidateLabel` — inside tenant configuration.
 *
 * ### ⚠️ Rules arrive in the request, and that is this slice's honest boundary
 *
 * Storing behaviour rules needs CRUD, versioning, an audit trail and a validation report, exactly as
 * `Rule` has. None of that is written yet. Taking them in the body makes the layer **reachable and
 * verifiable end to end today** without pretending a store exists — and a caller cannot mistake this
 * for a configured rule set, because they had to send it.
 *
 * ⚠️ `rule:read`, not `rule:write`: this evaluates and stores nothing. It is a question, not a change.
 *
 * [ADR-0052]: ../../../../../docs/adr/ADR-0052-behaviour-reasoning-is-not-perception.md
 */
import type { FastifyInstance } from 'fastify';
import { BehaviourRule } from '@vip/contracts';
import { z } from 'zod';
import type { Auth } from '../plugins/auth.js';
import { success } from '../http.js';
import {
  evaluateBehaviourRule,
  type BehaviourGraphView,
} from '../../domain/behaviour-reasoning.js';

/** How a caller names the slice of history to reason over. ⚠️ One of the two is required. */
const EvaluateBody = z.object({
  streamId: z.string().min(1).max(200).optional(),
  cameraId: z.string().min(1).max(200).optional(),
  identityId: z.string().min(1).max(200).optional(),
  /**
   * ⚠️ Capped. Each rule walks every identity's edges, so an unbounded list is a way to spend the
   * service's CPU from a browser. Ten is far past anything an operator composes by hand.
   */
  rules: z.array(BehaviourRule).min(1).max(10),
});

export interface BehaviourReasoningRoutesDeps {
  auth: Auth;
  /**
   * Fetches the behaviour graph for a query, carrying **the caller's own token**.
   *
   * ⛔ Not an internal key. The graph shows where named people went and who they were with; reading
   * it through a service credential would let anyone who can post a rule see movement they cannot
   * see anywhere else in the product. A privilege escalation through a join is invisible, because
   * nobody thinks to check an authorisation on a read-only explanation.
   */
  fetchGraph: (
    query: { streamId?: string; cameraId?: string; identityId?: string },
    authorization: string,
  ) => Promise<BehaviourGraphView | { unavailable: true; detail: string }>;
}

export function registerBehaviourReasoningRoutes(
  app: FastifyInstance,
  deps: BehaviourReasoningRoutesDeps,
): void {
  app.post(
    '/rules/behaviour/evaluate',
    { preHandler: deps.auth.authorize('rule:read') },
    async (request, reply) => {
      const parsed = EvaluateBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: 'invalid-request', message: parsed.error.issues[0]?.message ?? 'invalid body' },
        });
      }
      const body = parsed.data;
      if (body.streamId === undefined && body.cameraId === undefined) {
        /* ⚠️ Refused rather than defaulted to the whole tenant. An accidental estate-wide evaluation
         * is both expensive and, in a report, indistinguishable from a deliberate one. */
        return reply.code(400).send({
          error: {
            code: 'invalid-request',
            message: 'name the history to reason over: streamId or cameraId',
          },
        });
      }

      const started = Date.now();
      const graph = await deps.fetchGraph(
        {
          ...(body.streamId === undefined ? {} : { streamId: body.streamId }),
          ...(body.cameraId === undefined ? {} : { cameraId: body.cameraId }),
          ...(body.identityId === undefined ? {} : { identityId: body.identityId }),
        },
        String(request.headers.authorization ?? ''),
      );

      if ('unavailable' in graph) {
        /*
         * ⛔ 503 with the reason, never an empty candidate list. "No graph could be read" and "the
         * graph held nothing worth reporting" are opposite facts and they render identically as
         * `candidates: []` — the failure this project has now met nine times.
         */
        return reply.code(503).send({
          error: { code: 'graph-unavailable', message: graph.detail },
        });
      }

      const rules = body.rules.filter((rule) => rule.tenantId === request.principal!.tenantId);
      const candidates = rules.flatMap((rule) => evaluateBehaviourRule(rule, graph));
      const identities = graph.nodes.filter((node) => node.kind === 'identity').length;

      return reply.send(
        success({
          rulesEvaluated: rules.length,
          identitiesEvaluated: identities,
          candidates,
          /* ⛔ Carried through unchanged. Past the relational cap the pairwise families never ran, so
           * a rule with a `near` step could not have matched and its silence means nothing. */
          graphTruncated: graph.truncated ?? {
            nodes: false,
            edges: false,
            relational: false,
            identitiesConsidered: identities,
          },
          elapsedMs: Date.now() - started,
        }),
      );
    },
  );
}
