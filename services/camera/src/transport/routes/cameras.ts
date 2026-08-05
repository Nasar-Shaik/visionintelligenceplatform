/**
 * Transport: camera-inventory HTTP routes. Every route is permission-gated (deny-by-default via
 * @vip/permissions) and scoped to the caller's tenant resolved from the validated access token —
 * so a principal only ever addresses cameras in its own tenant (a camera from another tenant is a
 * 404, no existence leak). Bodies are validated against @vip/contracts (contract-first). ONVIF
 * discovery is stubbed (501) — the route contract exists ahead of the implementation (P1-4+).
 */
import type { FastifyInstance } from 'fastify';
import {
  BulkCreateCamerasInput,
  CameraQuery,
  CameraValidationInput,
  CreateCameraInput,
  DiscoverCamerasInput,
  UpdateCameraInput,
} from '@vip/contracts';
import type { HealthTrendWindow } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import type { CameraService } from '../../application/camera-service.js';
import type { Auth } from '../plugins/auth.js';
import { parseBody, success } from '../http.js';

export interface CameraRoutesDeps {
  service: CameraService;
  auth: Auth;
}

interface CameraParams {
  id: string;
}

/** `?zoneId=a&zoneId=b` arrives as a string or an array depending on how many were supplied. */
interface CameraListQuery {
  zoneId?: string | string[];
  status?: string;
  lifecycle?: string;
  search?: string;
  limit?: string;
  cursor?: string;
}

/**
 * Named trend windows only. An arbitrary hour count would quietly reinstate the lifetime average
 * these windows exist to prevent — a year of uptime hiding last night's outage.
 */
function parseWindow(requested: string | undefined): HealthTrendWindow | undefined {
  return (['hour', 'day', 'week', 'month'] as const).find((w) => w === requested);
}

export function registerCameraRoutes(app: FastifyInstance, deps: CameraRoutesDeps): void {
  const { service, auth } = deps;
  const scopeOf = (tenantId: string): TenantScope => TenantScope.fromTenantId(tenantId);

  app.post('/cameras', { preHandler: auth.authorize('camera:create') }, async (request, reply) => {
    const scope = scopeOf(request.principal!.tenantId);
    const input = parseBody(CreateCameraInput, request.body);
    return reply.status(201).send(success(await service.create(scope, input)));
  });

  /*
   * List cameras. Filtered and paginated when asked; the whole (bounded) inventory when not.
   *
   * The unfiltered response stays a bare array so every existing consumer keeps working — the paged
   * envelope appears only for a caller that asked a question needing one. Extending the existing
   * resource rather than adding `/cameras/search` keeps one way to ask for cameras.
   */
  app.get<{ Querystring: CameraListQuery }>(
    '/cameras',
    { preHandler: auth.authorize('camera:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const { zoneId, status, lifecycle, search, limit, cursor } = request.query;
      const filtered =
        zoneId !== undefined ||
        status !== undefined ||
        lifecycle !== undefined ||
        search !== undefined ||
        limit !== undefined ||
        cursor !== undefined;
      if (!filtered) return reply.send(success(await service.list(scope)));

      const zoneIds = zoneId === undefined ? undefined : Array.isArray(zoneId) ? zoneId : [zoneId];
      const query = parseBody(CameraQuery, {
        ...(zoneIds ? { zoneIds } : {}),
        ...(status ? { status } : {}),
        ...(lifecycle ? { lifecycle } : {}),
        ...(search ? { search } : {}),
        ...(limit !== undefined ? { limit: Number(limit) } : {}),
        ...(cursor ? { cursor } : {}),
      });
      return reply.send(success(await service.query(scope, query)));
    },
  );

  // Bulk onboarding — the DVR/NVR case (P-1). Static path, before `/cameras/:id`.
  app.post(
    '/cameras/bulk',
    { preHandler: auth.authorize('camera:create') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const input = parseBody(BulkCreateCamerasInput, request.body);
      const result = await service.createMany(scope, input);
      // 207-style semantics without the multipart body: partial success is the expected outcome of a
      // 16-channel DVR add, so the response is a 200 carrying per-camera outcomes rather than an
      // all-or-nothing status the console would have to guess at.
      return reply.status(result.failed === 0 ? 201 : 200).send(success(result));
    },
  );

  /**
   * ONVIF/network discovery (P-1). `camera:create` rather than `camera:read`: a probe is an active
   * network operation against the customer's estate, and the permission should match what it does,
   * not what it returns. Declared before `/cameras/:id` so it isn't captured by the param route.
   */
  app.post(
    '/cameras/discover',
    { preHandler: auth.authorize('camera:create') },
    async (request) => {
      const scope = scopeOf(request.principal!.tenantId);
      const input = parseBody(DiscoverCamerasInput, request.body ?? {});
      return success(await service.discover(scope, input));
    },
  );

  // Validate a candidate configuration before onboarding (P2-2 G-1, "test connection"). No
  // persistence; reports issues as structured checks. Static path — before `/cameras/:id`.
  app.post('/cameras/validate', { preHandler: auth.authorize('camera:read') }, async (request) => {
    const input = parseBody(CameraValidationInput, request.body);
    return success(service.validateConfig(input));
  });

  /**
   * Fleet-wide probe performance (P-2.2). Static path, declared before `/cameras/:id` so it is not
   * captured by the param route.
   */
  app.get<{ Querystring: { window?: string } }>(
    '/cameras/metrics',
    { preHandler: auth.authorize('camera:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const window = parseWindow(request.query.window);
      return reply.send(
        success(await service.fleetProbeMetrics(scope, { ...(window ? { window } : {}) })),
      );
    },
  );

  app.get<{ Params: CameraParams }>(
    '/cameras/:id',
    { preHandler: auth.authorize('camera:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.get(scope, request.params.id)));
    },
  );

  /**
   * ⚠️ **`If-Match` carries the record's `updatedAt`, and it is optional on purpose.**
   *
   * Measured at P-6.6: two administrators editing one camera at the same moment both received
   * HTTP 200 and one of the two edits was gone. The guard is the record's own `updatedAt`, sent back
   * by the caller and applied **in the write's filter** (see `CameraService.update`).
   *
   * A header rather than a body field, because `UpdateCameraInput` belongs to a **frozen
   * foundation** and a concurrency token is a transport concern, not a property of a camera. A
   * caller that sends no header behaves exactly as it did before — additive, no contract moves.
   */
  app.patch<{ Params: CameraParams }>(
    '/cameras/:id',
    { preHandler: auth.authorize('camera:update') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const patch = parseBody(UpdateCameraInput, request.body);
      const ifMatch = request.headers['if-match'];
      const expected = typeof ifMatch === 'string' ? ifMatch.replace(/^"|"$/g, '') : undefined;
      return reply.send(success(await service.update(scope, request.params.id, patch, expected)));
    },
  );

  app.delete<{ Params: CameraParams }>(
    '/cameras/:id',
    { preHandler: auth.authorize('camera:delete') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      await service.remove(scope, request.params.id);
      return reply.status(204).send();
    },
  );

  app.get<{ Params: CameraParams }>(
    '/cameras/:id/health',
    { preHandler: auth.authorize('camera:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.health(scope, request.params.id)));
    },
  );

  // --- P2-2 G-1 camera-service enhancements ---

  app.get<{ Params: CameraParams }>(
    '/cameras/:id/capabilities',
    { preHandler: auth.authorize('camera:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.capabilities(scope, request.params.id)));
    },
  );

  app.post<{ Params: CameraParams }>(
    '/cameras/:id/validate',
    { preHandler: auth.authorize('camera:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.validateExisting(scope, request.params.id)));
    },
  );

  // Active health re-check — deterministic config validation, persists the snapshot (mutates).
  app.post<{ Params: CameraParams }>(
    '/cameras/:id/health/check',
    { preHandler: auth.authorize('camera:update') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.checkHealth(scope, request.params.id)));
    },
  );

  // --- P-2: lifecycle, measured health, capability cache ---

  /**
   * Test a camera's connection against the physical device (P-2).
   *
   * `camera:update` rather than `camera:read`: this opens a stream on the customer's network and
   * writes the measured result to the record. The permission should match what a route *does*, not
   * what it returns.
   */
  app.post<{ Params: CameraParams }>(
    '/cameras/:id/probe',
    { preHandler: auth.authorize('camera:update') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.probeConnection(scope, request.params.id)));
    },
  );

  // Read capabilities, going back to the device only when that is warranted. `?force=true` is the
  // operator override; everything else is the cache decision.
  app.post<{ Params: CameraParams; Querystring: { force?: string } }>(
    '/cameras/:id/capabilities/refresh',
    { preHandler: auth.authorize('camera:update') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const force = request.query.force === 'true';
      return reply.send(
        success(await service.refreshCapabilities(scope, request.params.id, { force })),
      );
    },
  );

  /**
   * Trends over the recorded timeline — computed, never stored (P-2.1).
   *
   * `?window=hour|day|week|month`. Named windows rather than an arbitrary hour count because the
   * point is to *bound* the view: a lifetime average hides last night's outage behind a year of
   * uptime, and letting a caller ask for 100000 hours would quietly reinstate exactly that.
   */
  app.get<{ Params: CameraParams; Querystring: { window?: string } }>(
    '/cameras/:id/health/summary',
    { preHandler: auth.authorize('camera:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const window = parseWindow(request.query.window);
      return reply.send(
        success(
          await service.healthSummary(scope, request.params.id, {
            ...(window ? { window } : {}),
          }),
        ),
      );
    },
  );

  /**
   * Decommission a camera without destroying it (P-2). Deliberately separate from `DELETE`: retiring
   * keeps the record and its timeline, which an incident investigation may need months later.
   */
  app.post<{ Params: CameraParams }>(
    '/cameras/:id/retire',
    { preHandler: auth.authorize('camera:update') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.retire(scope, request.params.id)));
    },
  );

  app.post<{ Params: CameraParams }>(
    '/cameras/:id/reinstate',
    { preHandler: auth.authorize('camera:update') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.reinstate(scope, request.params.id)));
    },
  );

  // --- P-2.2: the immutable probe archive ---

  /**
   * A camera's retained probe reports (P-2.2). `camera:read` — this contacts nothing and changes
   * nothing; it is the archive being read back.
   */
  app.get<{ Params: CameraParams; Querystring: { limit?: string } }>(
    '/cameras/:id/probes',
    { preHandler: auth.authorize('camera:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const limit = Number.parseInt(request.query.limit ?? '', 10);
      return reply.send(
        success(
          await service.probeHistory(scope, request.params.id, {
            ...(Number.isFinite(limit) ? { limit } : {}),
          }),
        ),
      );
    },
  );

  // Per-camera probe performance. Declared before `/probes/:probeId` so `metrics` is not read as an id.
  app.get<{ Params: CameraParams; Querystring: { window?: string } }>(
    '/cameras/:id/probes/metrics',
    { preHandler: auth.authorize('camera:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const window = parseWindow(request.query.window);
      return reply.send(
        success(
          await service.probeMetrics(scope, request.params.id, { ...(window ? { window } : {}) }),
        ),
      );
    },
  );

  /**
   * Replay one stored probe (P-2.2). A **GET**, deliberately: nothing is measured, nothing is
   * contacted and nothing is written — it reconstructs stored evidence, and modelling it as a POST
   * would imply an action against the camera that this route is specifically incapable of.
   */
  app.get<{ Params: CameraParams & { probeId: string } }>(
    '/cameras/:id/probes/:probeId',
    { preHandler: auth.authorize('camera:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(
        success(await service.replay(scope, request.params.id, request.params.probeId)),
      );
    },
  );

  /** How this camera's reliability has moved (P-2.3). Derived, never stored. */
  app.get<{ Params: CameraParams; Querystring: { window?: string } }>(
    '/cameras/:id/confidence',
    { preHandler: auth.authorize('camera:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const window = parseWindow(request.query.window);
      return reply.send(
        success(
          await service.confidenceTrend(scope, request.params.id, {
            ...(window ? { window } : {}),
          }),
        ),
      );
    },
  );

  /**
   * Why the platform did what it did (P-2.3). Explainability only — this route reconstructs
   * decisions from stored evidence and changes nothing.
   */
  app.get<{ Params: CameraParams; Querystring: { window?: string } }>(
    '/cameras/:id/decisions',
    { preHandler: auth.authorize('camera:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const window = parseWindow(request.query.window);
      return reply.send(
        success(
          await service.decisions(scope, request.params.id, { ...(window ? { window } : {}) }),
        ),
      );
    },
  );

  /** Every record this camera has, in one chronology (P-2.2). */
  app.get<{ Params: CameraParams; Querystring: { window?: string } }>(
    '/cameras/:id/evidence',
    { preHandler: auth.authorize('camera:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const window = parseWindow(request.query.window);
      return reply.send(
        success(
          await service.evidence(scope, request.params.id, { ...(window ? { window } : {}) }),
        ),
      );
    },
  );

  app.post<{ Params: CameraParams }>(
    '/cameras/:id/enable',
    { preHandler: auth.authorize('camera:update') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.setStatus(scope, request.params.id, 'enabled')));
    },
  );

  app.post<{ Params: CameraParams }>(
    '/cameras/:id/disable',
    { preHandler: auth.authorize('camera:update') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.setStatus(scope, request.params.id, 'disabled')));
    },
  );
}
