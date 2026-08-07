/**
 * Transport: offline video investigation routes (P-8 Phase 8).
 *
 * Permissions follow the media service's existing split — creating, confirming, running, cancelling
 * and deleting are actions (`stream:control`); listing, reading and playback are reads
 * (`stream:read`). The tenant comes from the validated access token, so a principal only ever
 * addresses its own tenant's analyses and another tenant's is a `404` (no existence leak).
 *
 * ⚠️ **The bytes never pass through here.** `POST /analyses` hands back a presigned URL and the
 * browser writes straight to object storage; `POST /analyses/:id/confirm` is how the service learns
 * the upload landed. Routing a multi-gigabyte body through the edge, the gateway and this service
 * would buffer a customer's video three times and hold an authenticated connection open for a
 * quarter of an hour.
 */
import type { FastifyInstance } from 'fastify';
import {
  AnalysisSnapshotInput,
  AnalysisTimelineQuery,
  ConfirmVideoAnalysisInput,
  CreateVideoAnalysisInput,
  StartAnalysisSessionInput,
  VideoAnalysisQuery,
} from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import type { AnalysisService } from '../../application/analysis-service.js';
import type { Auth } from '../plugins/auth.js';
import { parseBody, success } from '../http.js';

export interface AnalysisRoutesDeps {
  analyses: AnalysisService;
  auth: Auth;
}

interface IdParams {
  id: string;
}

export function registerAnalysisRoutes(app: FastifyInstance, deps: AnalysisRoutesDeps): void {
  const { analyses, auth } = deps;
  const scopeOf = (tenantId: string): TenantScope => TenantScope.fromTenantId(tenantId);

  app.post(
    '/analyses',
    { preHandler: auth.authorize('stream:control') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const input = parseBody(CreateVideoAnalysisInput, request.body);
      const upload = await analyses.createUpload(scope, request.principal!.principalId, input);
      return reply.status(201).send(success(upload));
    },
  );

  app.get('/analyses', { preHandler: auth.authorize('stream:read') }, async (request, reply) => {
    const scope = scopeOf(request.principal!.tenantId);
    const query = parseBody(VideoAnalysisQuery, request.query ?? {});
    return reply.send(success(await analyses.list(scope, query)));
  });

  app.get<{ Params: IdParams }>(
    '/analyses/:id',
    { preHandler: auth.authorize('stream:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await analyses.detail(scope, request.params.id)));
    },
  );

  /**
   * ⭐ The investigation timeline — derived from the events one run produced (slice 4).
   *
   * ⚠️ `stream:read`, matching every other analysis read. It exposes no pixels and no detections,
   * only what was already persisted as events, so it needs no stronger permission than the detail
   * view an operator already has.
   */
  app.get<{ Params: IdParams }>(
    '/analyses/:id/timeline',
    { preHandler: auth.authorize('stream:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const query = parseBody(AnalysisTimelineQuery, request.query ?? {});
      /*
       * ⛔ **The caller's own authorization is forwarded to the events service, never a service key.**
       * The timeline must show exactly what the person asking for it is entitled to open; a service
       * key would work and would quietly widen that. Same decision `services/workflow` records for
       * the incident timeline.
       */
      const caller = { authorization: request.headers.authorization ?? '' };
      return reply.send(success(await analyses.timeline(scope, request.params.id, query, caller)));
    },
  );

  /**
   * ⭐ A still from a moment in the analysed recording (slice 6 — TD-15, offline).
   *
   * ⚠️ `stream:control`, not `stream:read`: it **writes** an object into the customer's storage and
   * spawns a decode. A read permission should never be able to make the platform do work.
   */
  app.post<{ Params: IdParams }>(
    '/analyses/:id/snapshots',
    { preHandler: auth.authorize('stream:control') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const input = parseBody(AnalysisSnapshotInput, request.body);
      return reply.status(201).send(success(await analyses.snapshot(scope, request.params.id, input)));
    },
  );

  app.post<{ Params: IdParams }>(
    '/analyses/:id/confirm',
    { preHandler: auth.authorize('stream:control') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const input = parseBody(ConfirmVideoAnalysisInput, request.body ?? {});
      return reply.send(success(await analyses.confirmUpload(scope, request.params.id, input)));
    },
  );

  /** ⭐ Called again on the same analysis, this is a rerun — a new session, not a replacement. */
  app.post<{ Params: IdParams }>(
    '/analyses/:id/sessions',
    { preHandler: auth.authorize('stream:control') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const input = parseBody(StartAnalysisSessionInput, request.body ?? {});
      const session = await analyses.startSession(
        scope,
        request.params.id,
        request.principal!.principalId,
        input,
      );
      return reply.status(201).send(success(session));
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    '/analysis-sessions/:sessionId/cancel',
    { preHandler: auth.authorize('stream:control') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await analyses.cancelSession(scope, request.params.sessionId)));
    },
  );

  app.get<{ Params: IdParams }>(
    '/analyses/:id/playback',
    { preHandler: auth.authorize('stream:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await analyses.playback(scope, request.params.id)));
    },
  );

  app.delete<{ Params: IdParams }>(
    '/analyses/:id',
    { preHandler: auth.authorize('stream:control') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      await analyses.remove(scope, request.params.id);
      return reply.status(204).send();
    },
  );
}
