/**
 * Transport: the Evidence API. Every route is permission-gated (deny-by-default via @vip/permissions)
 * and tenant-scoped from the validated access token, so a principal only ever sees its own tenant's
 * evidence — another tenant's item is a `404`. Retrieval is **signed-URL only**; download issuance is
 * an audited access. Reads = `evidence:read`; register = `evidence:create`; metadata = `evidence:update`;
 * retention/legal-hold = `evidence:manage` (admin/owner). Custody is read-only + verifiable.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  EvidenceQuery,
  RegisterEvidenceInput,
  SetRetentionInput,
  UpdateEvidenceMetadataInput,
} from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import type { EvidenceService } from '../../application/evidence-service.js';
import type { Auth } from '../plugins/auth.js';
import { parseBody, success } from '../http.js';

export interface EvidenceRoutesDeps {
  service: EvidenceService;
  auth: Auth;
}

interface IdParams {
  id: string;
}

const CustodyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});

export function registerEvidenceRoutes(app: FastifyInstance, deps: EvidenceRoutesDeps): void {
  const { service, auth } = deps;
  const scopeOf = (tenantId: string): TenantScope => TenantScope.fromTenantId(tenantId);
  const actorOf = (req: { principal: { principalId: string } | null }): string =>
    req.principal!.principalId;

  // --- list + read ------------------------------------------------------------------------------

  app.get('/evidence', { preHandler: auth.authorize('evidence:read') }, async (request, reply) => {
    const scope = scopeOf(request.principal!.tenantId);
    const query = parseBody(EvidenceQuery, request.query ?? {});
    return reply.send(success(await service.list(scope, query)));
  });

  app.get<{ Params: IdParams }>(
    '/evidence/:id',
    { preHandler: auth.authorize('evidence:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.get(scope, request.params.id)));
    },
  );

  app.get<{ Params: IdParams }>(
    '/evidence/:id/manifest',
    { preHandler: auth.authorize('evidence:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.manifest(scope, request.params.id)));
    },
  );

  // --- register ---------------------------------------------------------------------------------

  app.post(
    '/evidence',
    { preHandler: auth.authorize('evidence:create') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const input = parseBody(RegisterEvidenceInput, request.body ?? {});
      const evidence = await service.register(scope, actorOf(request), input);
      return reply.status(201).send(success(evidence));
    },
  );

  // --- secure retrieval (signed URL; audited access) --------------------------------------------

  app.get<{ Params: IdParams; Querystring: { reason?: string } }>(
    '/evidence/:id/download',
    { preHandler: auth.authorize('evidence:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const target = await service.download(
        scope,
        request.params.id,
        actorOf(request),
        request.query?.reason,
      );
      return reply.send(success(target));
    },
  );

  /**
   * Resolve a playback session (P-5.5).
   *
   * ⚠️ **`evidence:read`, not a new `playback:read`.** `REFUSED_WORKSPACE_PERMISSIONS` records why:
   * playback resolves an evidence record that is already permissioned, and a second gate over the
   * same authority can disagree with the first — in whichever direction the code happens to check.
   */
  app.get<{ Params: IdParams; Querystring: { reason?: string } }>(
    '/evidence/:id/playback',
    { preHandler: auth.authorize('evidence:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const session = await service.playbackSession(
        scope,
        request.params.id,
        actorOf(request),
        request.query?.reason,
      );
      return reply.send(success(session));
    },
  );

  // --- version-safe metadata --------------------------------------------------------------------

  app.patch<{ Params: IdParams }>(
    '/evidence/:id/metadata',
    { preHandler: auth.authorize('evidence:update') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const patch = parseBody(UpdateEvidenceMetadataInput, request.body ?? {});
      return reply.send(
        success(await service.updateMetadata(scope, request.params.id, actorOf(request), patch)),
      );
    },
  );

  // --- retention / legal hold -------------------------------------------------------------------

  app.post<{ Params: IdParams }>(
    '/evidence/:id/retention',
    { preHandler: auth.authorize('evidence:manage') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const input = parseBody(SetRetentionInput, request.body ?? {});
      return reply.send(
        success(await service.setRetention(scope, request.params.id, actorOf(request), input)),
      );
    },
  );

  // --- chain of custody -------------------------------------------------------------------------

  app.get<{ Params: IdParams }>(
    '/evidence/:id/custody',
    { preHandler: auth.authorize('evidence:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const q = parseBody(CustodyQuery, request.query ?? {});
      return reply.send(
        success(
          await service.listCustody(scope, request.params.id, {
            limit: q.limit,
            ...(q.cursor ? { cursor: q.cursor } : {}),
          }),
        ),
      );
    },
  );

  app.get<{ Params: IdParams }>(
    '/evidence/:id/custody/verify',
    { preHandler: auth.authorize('evidence:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success({ valid: await service.verifyCustody(scope, request.params.id) }));
    },
  );
}
