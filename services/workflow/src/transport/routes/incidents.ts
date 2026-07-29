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
  CloseIncidentInput,
  IncidentQuery,
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

interface RawQuery {
  status?: string;
  severity?: string;
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
      status: raw.status,
      severity: raw.severity,
      limit: raw.limit !== undefined ? Number(raw.limit) : undefined,
      cursor: raw.cursor,
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
