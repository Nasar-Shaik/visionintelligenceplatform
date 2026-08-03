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

  app.post<{ Params: IncidentParams }>(
    '/incidents/:id/close',
    { preHandler: auth.authorize('incident:resolve') },
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
