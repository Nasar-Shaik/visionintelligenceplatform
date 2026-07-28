/**
 * Transport: internal (service-to-service) routes. NOT exposed to end users — authenticated by the
 * shared internal key (the gateway strips `x-internal-key`, so a client cannot reach these through
 * it). `GET /internal/cameras/:id/stream` returns a camera's connection descriptor **with decrypted
 * credentials** for the media service to connect an RTSP/RTMP stream (INGESTION_PIPELINE.md). The
 * caller names the tenant via `x-tenant-id` (trusted, since it holds the internal key).
 */
import type { FastifyInstance } from 'fastify';
import { TenantScope } from '@vip/tenancy';
import type { CameraService } from '../../application/camera-service.js';
import { requireInternalKey } from '../plugins/internal-auth.js';
import { badRequest } from '../../application/errors.js';
import { success } from '../http.js';

export interface InternalRoutesDeps {
  service: CameraService;
  internalKey: string;
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
}
