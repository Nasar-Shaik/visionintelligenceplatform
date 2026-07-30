/**
 * Transport: clip catalog + playback routes (P2-2 G-2). Creating and deleting a clip is an action
 * (`stream:control`); listing/fetching/playback are reads (`stream:read`) — deny-by-default via
 * @vip/permissions. The tenant is resolved from the validated access token, so a principal only ever
 * addresses its own tenant's clips — another tenant's clip is a `404` (no existence leak).
 */
import type { FastifyInstance } from 'fastify';
import { ClipQuery, CreateClipInput } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import type { MediaCatalogService } from '../../application/media-catalog-service.js';
import type { Auth } from '../plugins/auth.js';
import { parseBody, success } from '../http.js';

export interface ClipRoutesDeps {
  catalog: MediaCatalogService;
  auth: Auth;
}

interface ClipParams {
  id: string;
}

export function registerClipRoutes(app: FastifyInstance, deps: ClipRoutesDeps): void {
  const { catalog, auth } = deps;
  const scopeOf = (tenantId: string): TenantScope => TenantScope.fromTenantId(tenantId);

  app.post('/clips', { preHandler: auth.authorize('stream:control') }, async (request, reply) => {
    const scope = scopeOf(request.principal!.tenantId);
    const input = parseBody(CreateClipInput, request.body);
    const clip = await catalog.createClip(scope, request.principal!.principalId, input);
    return reply.status(201).send(success(clip));
  });

  app.get('/clips', { preHandler: auth.authorize('stream:read') }, async (request, reply) => {
    const scope = scopeOf(request.principal!.tenantId);
    const query = parseBody(ClipQuery, request.query ?? {});
    return reply.send(success(await catalog.listClips(scope, query)));
  });

  app.get<{ Params: ClipParams }>(
    '/clips/:id',
    { preHandler: auth.authorize('stream:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await catalog.getClip(scope, request.params.id)));
    },
  );

  app.get<{ Params: ClipParams }>(
    '/clips/:id/playback',
    { preHandler: auth.authorize('stream:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await catalog.clipPlayback(scope, request.params.id)));
    },
  );

  app.delete<{ Params: ClipParams }>(
    '/clips/:id',
    { preHandler: auth.authorize('stream:control') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      await catalog.deleteClip(scope, request.params.id);
      return reply.status(204).send();
    },
  );
}
