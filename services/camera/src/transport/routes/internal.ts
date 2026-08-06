/**
 * Transport: internal (service-to-service) routes. NOT exposed to end users — authenticated by the
 * shared internal key (the gateway strips `x-internal-key`, so a client cannot reach these through
 * it). `GET /internal/cameras/:id/stream` returns a camera's connection descriptor **with decrypted
 * credentials** for the media service to connect an RTSP/RTMP stream (INGESTION_PIPELINE.md). The
 * caller names the tenant via `x-tenant-id` (trusted, since it holds the internal key).
 */
import type { FastifyInstance } from 'fastify';
import { AssignmentObservationReport } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import { z } from 'zod';
import type { CameraService } from '../../application/camera-service.js';
import type { AssignmentService } from '../../application/assignment-service.js';
import type { ZoneService } from '../../application/zone-service.js';
import { requireInternalKey } from '../plugins/internal-auth.js';
import { badRequest } from '../../application/errors.js';
import { parseBody, success } from '../http.js';

export interface InternalRoutesDeps {
  service: CameraService;
  internalKey: string;
  /** Absent in deployments built before P-8 Phase 6 wiring; the routes are then not mounted. */
  assignments?: AssignmentService;
  /** Absent in deployments built before P-8 Phase 7 wiring; the routes are then not mounted. */
  zones?: ZoneService;
}

/**
 * ⚠️ Capped at the rule-scope ceilings. A validation call is authenticated by a service key, not by
 * a user, so nothing upstream has already bounded these arrays — an unbounded `$in` here would be a
 * denial of service reachable by any process holding the internal key.
 */
const ScopeResolveBody = z.object({
  cameraIds: z.array(z.string().min(1)).max(500).optional(),
  groupIds: z.array(z.string().min(1)).max(100).optional(),
  zoneIds: z.array(z.string().min(1)).max(500).optional(),
});

interface CameraParams {
  id: string;
}

export function registerInternalRoutes(app: FastifyInstance, deps: InternalRoutesDeps): void {
  const preHandler = requireInternalKey(deps.internalKey);

  app.get<{ Params: CameraParams }>(
    '/internal/cameras/:id/stream',
    { preHandler },
    async (request, reply) => {
      const tenantId = request.headers['x-tenant-id'];
      if (typeof tenantId !== 'string' || tenantId.trim() === '') {
        throw badRequest('x-tenant-id header is required');
      }
      const scope = TenantScope.fromTenantId(tenantId);
      return reply.send(success(await deps.service.resolveConnection(scope, request.params.id)));
    },
  );

  /*
   * ═══ Camera Processing Assignment (P-8 Phase 6) ═══════════════════════════════════════════════
   *
   * ⚠️ **Cross-tenant, and behind the internal key for exactly that reason.** One media deployment
   * ingests every tenant's cameras, so a per-tenant plan would mean media polling N endpoints and
   * discovering a new tenant by accident. The gateway strips `x-internal-key`, so neither of these
   * is reachable from a browser however the URL is spelled.
   */
  const assignments = deps.assignments;
  if (assignments === undefined) return;

  app.get('/internal/assignment/plan', { preHandler }, async (_request, reply) =>
    reply.send(success(await assignments.plan())),
  );

  /*
   * ⚠️ The only route in the platform that can move an assignment into an *observed* state. The
   * control plane believes nothing about what is running until this is called — see
   * `domain/assignment.ts`.
   */
  app.post('/internal/assignment/report', { preHandler }, async (request, reply) => {
    const report = parseBody(AssignmentObservationReport, request.body);
    return reply.send(success(await assignments.report(report)));
  });

  /*
   * ═══ Detection zones (P-8 Phase 7) ════════════════════════════════════════════════════════════
   *
   * Two routes the **rules service** calls, both behind the internal key:
   *
   *   - `POST /internal/zones/resolve` — validation-time scope resolution, tenant-scoped by the
   *     `x-tenant-id` header. One call for cameras, groups and zones together, so a save that is
   *     waiting on it waits once. See `ZoneService.resolveScope`.
   *   - `GET  /internal/zones/catalog` — a compact cross-tenant list for the rules engine's
   *     synchronous name/version lookup, refreshed on an interval. ⚠️ Cross-tenant for the same
   *     reason the plan is: one rules deployment evaluates every tenant.
   */
  const zones = deps.zones;
  if (zones === undefined) return;

  app.post('/internal/zones/resolve', { preHandler }, async (request, reply) => {
    const tenantId = request.headers['x-tenant-id'];
    if (typeof tenantId !== 'string' || tenantId.trim() === '') {
      throw badRequest('x-tenant-id header is required');
    }
    const body = parseBody(ScopeResolveBody, request.body);
    const scope = TenantScope.fromTenantId(tenantId);
    return reply.send(
      success(
        await zones.resolveScope(scope, {
          ...(body.cameraIds === undefined ? {} : { cameraIds: body.cameraIds }),
          ...(body.groupIds === undefined ? {} : { groupIds: body.groupIds }),
          ...(body.zoneIds === undefined ? {} : { zoneIds: body.zoneIds }),
        }),
      ),
    );
  });

  app.get('/internal/zones/catalog', { preHandler }, async (_request, reply) =>
    reply.send(success(await zones.catalog())),
  );
}
