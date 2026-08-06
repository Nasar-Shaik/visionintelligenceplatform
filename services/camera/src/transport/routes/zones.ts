/**
 * Transport: **detection zone** routes (P-8 Phase 7 §Zones).
 *
 * Tenant-scoped and permission-gated like every other camera route. The permission split follows the
 * one Camera Processing Assignment established, for the same reason:
 *
 *   - `camera:read`  — see zones. A zone is device configuration, and anyone who can watch the
 *     footage can already see where the operator drew a box on it.
 *   - `camera:write` — draw, move, rename, enable, delete. Moving a polygon changes which incidents
 *     the platform raises, which is a change to what the customer is told about their store.
 *
 * ### ⚠️ Route order
 *
 * `/zones/versions/...` would be shadowed by `/zones/:zoneId` if declared after it — the same trap
 * `/assignments/capacity` documents. The version routes are nested under `:zoneId` instead, which
 * keeps the ordering unambiguous rather than merely correct today.
 */
import type { FastifyInstance } from 'fastify';
import { CreateDetectionZoneInput, UpdateDetectionZoneInput } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import { z } from 'zod';
import type { ZoneService } from '../../application/zone-service.js';
import type { Auth } from '../plugins/auth.js';
import { parseBody, success } from '../http.js';

export interface ZoneRoutesDeps {
  zones: ZoneService;
  auth: Auth;
}

interface ZoneParams {
  zoneId: string;
}

interface VersionParams extends ZoneParams {
  version: string;
}

const ListQuery = z.object({ cameraId: z.string().min(1).optional() });

export function registerZoneRoutes(app: FastifyInstance, deps: ZoneRoutesDeps): void {
  const { zones, auth } = deps;

  /* Same helpers as the assignment routes: the tenant and the actor come from the verified
   * principal and from nowhere else. A zone edit is an audited change to what the platform reports. */
  const scopeOf = (request: { principal: { tenantId: string } | null }): TenantScope =>
    TenantScope.fromTenantId(request.principal!.tenantId);
  const actorOf = (request: { principal: { principalId: string } | null }): string =>
    request.principal?.principalId ?? 'unknown';

  app.get<{ Querystring: { cameraId?: string } }>(
    '/zones',
    { preHandler: auth.authorize('camera:read') },
    async (request, reply) => {
      const scope = scopeOf(request);
      const query = ListQuery.parse(request.query ?? {});
      return reply.send(success(await zones.list(scope, query.cameraId)));
    },
  );

  app.post('/zones', { preHandler: auth.authorize('camera:write') }, async (request, reply) => {
    const scope = scopeOf(request);
    const input = parseBody(CreateDetectionZoneInput, request.body);
    const zone = await zones.create(scope, input, actorOf(request));
    return reply.code(201).send(success(zone));
  });

  app.get<{ Params: ZoneParams }>(
    '/zones/:zoneId',
    { preHandler: auth.authorize('camera:read') },
    async (request, reply) => {
      const scope = scopeOf(request);
      return reply.send(success(await zones.get(scope, request.params.zoneId)));
    },
  );

  app.patch<{ Params: ZoneParams }>(
    '/zones/:zoneId',
    { preHandler: auth.authorize('camera:write') },
    async (request, reply) => {
      const scope = scopeOf(request);
      const patch = parseBody(UpdateDetectionZoneInput, request.body);
      const zone = await zones.update(scope, request.params.zoneId, patch, actorOf(request));
      return reply.send(success(zone));
    },
  );

  app.delete<{ Params: ZoneParams }>(
    '/zones/:zoneId',
    { preHandler: auth.authorize('camera:write') },
    async (request, reply) => {
      const scope = scopeOf(request);
      await zones.remove(scope, request.params.zoneId, actorOf(request));
      return reply.code(204).send();
    },
  );

  /**
   * A zone's whole history, newest first (Architect rec 2).
   *
   * ⚠️ Available for a **deleted** zone too — the history outlives the zone, because an incident that
   * names it must still resolve. See `ZoneService.remove`.
   */
  app.get<{ Params: ZoneParams }>(
    '/zones/:zoneId/versions',
    { preHandler: auth.authorize('camera:read') },
    async (request, reply) => {
      const scope = scopeOf(request);
      return reply.send(success(await zones.versions(scope, request.params.zoneId)));
    },
  );

  /** The geometry **as it was** — what an incident detail page draws over old footage. */
  app.get<{ Params: VersionParams }>(
    '/zones/:zoneId/versions/:version',
    { preHandler: auth.authorize('camera:read') },
    async (request, reply) => {
      const scope = scopeOf(request);
      const version = Number.parseInt(request.params.version, 10);
      return reply.send(success(await zones.versionAt(scope, request.params.zoneId, version)));
    },
  );
}
