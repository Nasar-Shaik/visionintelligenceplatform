/**
 * Transport: camera-inventory HTTP routes. Every route is permission-gated (deny-by-default via
 * @vip/permissions) and scoped to the caller's tenant resolved from the validated access token —
 * so a principal only ever addresses cameras in its own tenant (a camera from another tenant is a
 * 404, no existence leak). Bodies are validated against @vip/contracts (contract-first). ONVIF
 * discovery is stubbed (501) — the route contract exists ahead of the implementation (P1-4+).
 */
import type { FastifyInstance } from 'fastify';
import {
  CameraValidationInput,
  CreateCameraInput,
  DiscoverCamerasInput,
  UpdateCameraInput,
} from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import type { CameraService } from '../../application/camera-service.js';
import type { Auth } from '../plugins/auth.js';
import { notImplemented } from '../../application/errors.js';
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

  // Discovery stub — declared before `/cameras/:id` so it isn't captured by the param route.
  app.post(
    '/cameras/discover',
    { preHandler: auth.authorize('camera:create') },
    async (request) => {
      parseBody(DiscoverCamerasInput, request.body ?? {});
      throw notImplemented('ONVIF/network camera discovery is not yet implemented');
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
