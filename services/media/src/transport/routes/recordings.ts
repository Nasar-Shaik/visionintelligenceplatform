/**
 * Transport: recording catalog + playback routes (P2-2 G-2). Read-only — listing, fetching, and
 * resolving a short-lived signed playback URL for stored recordings; all require `stream:read`
 * (deny-by-default via @vip/permissions). The tenant is resolved from the validated access token, so
 * a principal only ever sees its own tenant's recordings — another tenant's recording is a `404`.
 */
import type { FastifyInstance } from 'fastify';
import { RecordingQuery } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import type { MediaCatalogService } from '../../application/media-catalog-service.js';
import type { Auth } from '../plugins/auth.js';
import { parseBody, success } from '../http.js';

export interface RecordingRoutesDeps {
  catalog: MediaCatalogService;
  auth: Auth;
}

interface RecordingParams {
  id: string;
}

export function registerRecordingRoutes(app: FastifyInstance, deps: RecordingRoutesDeps): void {
  const { catalog, auth } = deps;
  const scopeOf = (tenantId: string): TenantScope => TenantScope.fromTenantId(tenantId);

  app.get('/recordings', { preHandler: auth.authorize('stream:read') }, async (request, reply) => {
    const scope = scopeOf(request.principal!.tenantId);
    const query = parseBody(RecordingQuery, request.query ?? {});
    return reply.send(success(await catalog.listRecordings(scope, query)));
  });

  app.get<{ Params: RecordingParams }>(
    '/recordings/:id',
    { preHandler: auth.authorize('stream:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await catalog.getRecording(scope, request.params.id)));
    },
  );

  app.get<{ Params: RecordingParams }>(
    '/recordings/:id/playback',
    { preHandler: auth.authorize('stream:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await catalog.recordingPlayback(scope, request.params.id)));
    },
  );
}
