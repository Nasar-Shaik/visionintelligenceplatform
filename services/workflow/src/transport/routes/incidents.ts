/**
 * Transport: incident lifecycle routes. Read + operator transitions only — incidents are never
 * created via the API (they are promoted from `incident.candidate` by the consumer), which keeps the
 * automation flow the single source of incidents. Every route is permission-gated (deny-by-default)
 * and scoped to the caller's tenant from the validated access token — another tenant's incident is a
 * 404 (no existence leak). An illegal lifecycle move (e.g. closing a `raised` incident) is a 409.
 */
import type { FastifyInstance } from 'fastify';
import {
  AcknowledgeIncidentInput,
  IncidentTimelineSource,
  AddIncidentNoteInput,
  AssignIncidentInput,
  CloseIncidentInput,
  EscalateIncidentInput,
  IncidentQuery,
  InvestigateIncidentInput,
  ResolveIncidentInput,
} from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import { notFound } from '../../application/errors.js';
import type { IncidentService } from '../../application/incident-service.js';
import type { Auth } from '../plugins/auth.js';
import { parseBody, success } from '../http.js';

export interface IncidentRoutesDeps {
  service: IncidentService;
  auth: Auth;
}

interface IncidentParams {
  id: string;
}

/**
 * The raw query string. Every key is a string here and is handed to `IncidentQuery` to validate —
 * `limit` is the only one that needs coercing, and an unknown key is dropped by the schema rather
 * than silently widening the search.
 */
interface RawQuery {
  status?: string;
  severity?: string;
  category?: string;
  eventType?: string;
  cameraId?: string;
  zoneId?: string;
  ruleId?: string;
  correlationId?: string;
  assignee?: string;
  from?: string;
  to?: string;
  limit?: string;
  cursor?: string;
}

/**
 * Parse `?include=events,evidence,notify` into validated sources.
 *
 * An unrecognised name is **dropped**, not rejected: a client asking for a source that does not
 * exist gets a timeline without it plus a `not-requested` gap, which is more useful than a 400 on a
 * read. `incident` is always included and never needs asking for.
 */
function parseInclude(raw: string | undefined): IncidentTimelineSource[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(
      (part): part is IncidentTimelineSource => IncidentTimelineSource.safeParse(part).success,
    )
    .filter((source) => source !== 'incident');
}

export function registerIncidentRoutes(app: FastifyInstance, deps: IncidentRoutesDeps): void {
  const { service, auth } = deps;
  const scopeOf = (tenantId: string): TenantScope => TenantScope.fromTenantId(tenantId);

  app.get('/incidents', { preHandler: auth.authorize('incident:read') }, async (request, reply) => {
    const scope = scopeOf(request.principal!.tenantId);
    const raw = request.query as RawQuery;
    const query = parseBody(IncidentQuery, {
      ...raw,
      limit: raw.limit !== undefined ? Number(raw.limit) : undefined,
    });
    return reply.send(success(await service.list(scope, query)));
  });

  app.get<{ Params: IncidentParams }>(
    '/incidents/:id',
    { preHandler: auth.authorize('incident:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const incident = await service.get(scope, request.params.id);
      if (!incident) throw notFound(`incident ${request.params.id} not found`);
      return reply.send(success(incident));
    },
  );

  app.post<{ Params: IncidentParams }>(
    '/incidents/:id/ack',
    { preHandler: auth.authorize('incident:ack') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const input = parseBody(AcknowledgeIncidentInput, request.body ?? {});
      const updated = await service.acknowledge(
        scope,
        request.params.id,
        input,
        request.principal!.principalId,
      );
      return reply.send(success(updated));
    },
  );

  app.post<{ Params: IncidentParams }>(
    '/incidents/:id/resolve',
    { preHandler: auth.authorize('incident:resolve') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const input = parseBody(ResolveIncidentInput, request.body ?? {});
      const updated = await service.resolve(
        scope,
        request.params.id,
        input,
        request.principal!.principalId,
      );
      return reply.send(success(updated));
    },
  );

  app.get<{ Params: IncidentParams }>(
    '/incidents/:id/activity',
    { preHandler: auth.authorize('incident:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.activity(scope, request.params.id)));
    },
  );

  /**
   * The full investigation timeline (P-5.1, F-3).
   *
   * `?include=events,evidence,notify` is **opt-in per source**, because the incident header must
   * not pay for the evidence panel. A source that is unreachable becomes a named `gap` in the
   * response rather than a 5xx — a partial timeline that says it is partial beats no timeline.
   */
  app.get<{ Params: IncidentParams; Querystring: { include?: string } }>(
    '/incidents/:id/timeline',
    { preHandler: auth.authorize('incident:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const include = parseInclude(request.query.include);
      /*
       * ⚠️ The caller's own token is forwarded into every join. A service key here would let the
       * timeline show events, evidence and notifications the operator cannot open anywhere else —
       * a privilege escalation through a read-only narrative, which is where nobody looks for one.
       */
      const caller = { authorization: request.headers.authorization };
      return reply.send(success(await service.timeline(scope, request.params.id, include, caller)));
    },
  );

  /**
   * The evidence chain (P-5.3, rec 7) — why this incident exists and what can be shown for it.
   *
   * ⚠️ Unresolved stages carry a **reason**, not a silence: an event that aged out, evidence that
   * was never captured, and a feature that is not built are three different answers and only one of
   * them means anything is wrong.
   */
  app.get<{ Params: IncidentParams }>(
    '/incidents/:id/chain',
    { preHandler: auth.authorize('incident:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      /* The same caller-scoped join rule as the timeline (CONSTRAINTS §70). */
      const caller = { authorization: request.headers.authorization };
      return reply.send(success(await service.chain(scope, request.params.id, caller)));
    },
  );

  /**
   * Derived SLA attainment (P-5.1, F-4). ⚠️ Returns `state: 'unknown'` when the deployment has
   * configured no policy for this tenant and severity — never a flattering default.
   */
  app.get<{ Params: IncidentParams }>(
    '/incidents/:id/sla',
    { preHandler: auth.authorize('incident:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.sla(scope, request.params.id)));
    },
  );

  app.post<{ Params: IncidentParams }>(
    '/incidents/:id/investigate',
    { preHandler: auth.authorize('incident:investigate') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const input = parseBody(InvestigateIncidentInput, request.body ?? {});
      const updated = await service.investigate(
        scope,
        request.params.id,
        input,
        request.principal!.principalId,
      );
      return reply.send(success(updated));
    },
  );

  app.post<{ Params: IncidentParams }>(
    '/incidents/:id/escalate',
    { preHandler: auth.authorize('incident:escalate') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const input = parseBody(EscalateIncidentInput, request.body ?? {});
      const updated = await service.escalate(
        scope,
        request.params.id,
        input,
        request.principal!.principalId,
      );
      return reply.send(success(updated));
    },
  );

  /**
   * Assign or un-assign. **Not a lifecycle route** — the status is unchanged, which is why this is
   * `/assign` rather than a transition alongside ack/resolve/close.
   */
  app.post<{ Params: IncidentParams }>(
    '/incidents/:id/assign',
    { preHandler: auth.authorize('incident:assign') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const input = parseBody(AssignIncidentInput, request.body ?? {});
      const updated = await service.assign(
        scope,
        request.params.id,
        input,
        request.principal!.principalId,
      );
      return reply.send(success(updated));
    },
  );

  app.post<{ Params: IncidentParams }>(
    '/incidents/:id/notes',
    { preHandler: auth.authorize('incident:comment') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const input = parseBody(AddIncidentNoteInput, request.body ?? {});
      const updated = await service.addNote(
        scope,
        request.params.id,
        input,
        request.principal!.principalId,
      );
      return reply.status(201).send(success(updated));
    },
  );

  /**
   * Close. Gated on `incident:close` (P-5.1) rather than `incident:resolve`, so a tenant can require
   * a different authority to sign off. The `operator` role still holds it, so no deployment loses an
   * ability it had — the split is additive.
   */
  app.post<{ Params: IncidentParams }>(
    '/incidents/:id/close',
    { preHandler: auth.authorize('incident:close') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const input = parseBody(CloseIncidentInput, request.body ?? {});
      const updated = await service.close(
        scope,
        request.params.id,
        input,
        request.principal!.principalId,
      );
      return reply.send(success(updated));
    },
  );
}
