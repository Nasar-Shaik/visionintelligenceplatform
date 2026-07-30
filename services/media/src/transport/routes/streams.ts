/**
 * Transport: stream control + status routes. Start/stop require `stream:control`; status/list
 * require `stream:read` (deny-by-default via @vip/permissions). The tenant is resolved from the
 * validated access token, so a principal only ever controls/sees its own tenant's streams — a
 * camera in another tenant is a `404` (no existence leak). See INGESTION_PIPELINE.md §APIs.
 */
import type { FastifyInstance } from 'fastify';
import type { StreamSupervisor } from '../../application/stream-supervisor.js';
import type { Auth } from '../plugins/auth.js';
import { success } from '../http.js';

export interface StreamRoutesDeps {
  supervisor: StreamSupervisor;
  auth: Auth;
}

interface CameraParams {
  cameraId: string;
}

export function registerStreamRoutes(app: FastifyInstance, deps: StreamRoutesDeps): void {
  const { supervisor, auth } = deps;
  const tenantOf = (request: { principal: { tenantId: string } | null }): string =>
    request.principal!.tenantId;

  app.get('/streams', { preHandler: auth.authorize('stream:read') }, async (request, reply) => {
    return reply.send(success(supervisor.list(tenantOf(request))));
  });

  // Aggregate stream health (P2-2 G-2). Static path — declared before `/streams/:cameraId/*`.
  app.get(
    '/streams/health',
    { preHandler: auth.authorize('stream:read') },
    async (request, reply) => {
      return reply.send(success(supervisor.healthSummary(tenantOf(request))));
    },
  );

  app.post<{ Params: CameraParams }>(
    '/streams/:cameraId/start',
    { preHandler: auth.authorize('stream:control') },
    async (request, reply) => {
      const status = supervisor.start(tenantOf(request), request.params.cameraId);
      return reply.status(202).send(success(status));
    },
  );

  app.post<{ Params: CameraParams }>(
    '/streams/:cameraId/stop',
    { preHandler: auth.authorize('stream:control') },
    async (request, reply) => {
      const status = await supervisor.stop(tenantOf(request), request.params.cameraId);
      return reply.send(success(status));
    },
  );

  app.get<{ Params: CameraParams }>(
    '/streams/:cameraId/status',
    { preHandler: auth.authorize('stream:read') },
    async (request, reply) => {
      return reply.send(success(supervisor.status(tenantOf(request), request.params.cameraId)));
    },
  );

  // Per-stream health view (P2-2 G-2).
  app.get<{ Params: CameraParams }>(
    '/streams/:cameraId/health',
    { preHandler: auth.authorize('stream:read') },
    async (request, reply) => {
      return reply.send(
        success(supervisor.streamHealth(tenantOf(request), request.params.cameraId)),
      );
    },
  );
}
