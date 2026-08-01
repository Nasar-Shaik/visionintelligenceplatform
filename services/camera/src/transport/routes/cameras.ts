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
  CameraValidationInput,
  CreateCameraInput,
  DiscoverCamerasInput,
  UpdateCameraInput,
} from '@vip/contracts';
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

export function registerCameraRoutes(app: FastifyInstance, deps: CameraRoutesDeps): void {
  const { service, auth } = deps;
  const scopeOf = (tenantId: string): TenantScope => TenantScope.fromTenantId(tenantId);

  app.post('/cameras', { preHandler: auth.authorize('camera:create') }, async (request, reply) => {
    const scope = scopeOf(request.principal!.tenantId);
    const input = parseBody(CreateCameraInput, request.body);
    return reply.status(201).send(success(await service.create(scope, input)));
  });

  app.get('/cameras', { preHandler: auth.authorize('camera:read') }, async (request, reply) => {
    const scope = scopeOf(request.principal!.tenantId);
    return reply.send(success(await service.list(scope)));
  });

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

  app.get<{ Params: CameraParams }>(
    '/cameras/:id',
    { preHandler: auth.authorize('camera:read') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      return reply.send(success(await service.get(scope, request.params.id)));
    },
  );

  app.patch<{ Params: CameraParams }>(
    '/cameras/:id',
    { preHandler: auth.authorize('camera:update') },
    async (request, reply) => {
      const scope = scopeOf(request.principal!.tenantId);
      const patch = parseBody(UpdateCameraInput, request.body);
      return reply.send(success(await service.update(scope, request.params.id, patch)));
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
