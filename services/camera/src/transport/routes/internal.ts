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
import type { CameraService } from '../../application/camera-service.js';
import type { AssignmentService } from '../../application/assignment-service.js';
import { requireInternalKey } from '../plugins/internal-auth.js';
import { badRequest } from '../../application/errors.js';
import { parseBody, success } from '../http.js';

export interface InternalRoutesDeps {
  service: CameraService;
  internalKey: string;
  /** Absent in deployments built before P-8 Phase 6 wiring; the routes are then not mounted. */
  assignments?: AssignmentService;
}

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
}
