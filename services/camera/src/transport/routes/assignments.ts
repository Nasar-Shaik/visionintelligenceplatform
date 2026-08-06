/**
 * Transport: **Camera Processing Assignment** routes (P-8 Phase 6).
 *
 * Every route is permission-gated (deny-by-default) and scoped to the caller's tenant, resolved from
 * the validated access token and from nowhere else — a camera in another tenant is a `404`.
 *
 * ### ⚠️ The permission split, and why it is not one permission
 *
 *   - `assignment:read`    — every view. Rides `*:read`, deliberately: which cameras are analysed is
 *     device configuration, and a viewer can already watch the footage.
 *   - `assignment:control` — **pause and resume only**. Shift work: suspending analytics on a till
 *     while an engineer is under it must not require an administrator, or it will not happen.
 *   - `assignment:write`   — enable, disable, restart, bind profiles, move runtimes, bulk, groups.
 *     Every one of these changes what the deployment analyses and what it costs.
 *   - `assignment:runtime` — register and remove runtimes. Deployment infrastructure.
 *
 * ### ⚠️ Route order
 *
 * Static paths (`/assignments/capacity`, `/assignments/bulk`, `/assignments/history`) are declared
 * **before** `/assignments/:cameraId`, or Fastify resolves `capacity` as a camera id and every
 * capacity read becomes a 404 for a camera nobody owns.
 */
import type { FastifyInstance } from 'fastify';
import {
  BulkAssignmentRequest,
  CreateCameraGroupInput,
  CreateProcessingProfileInput,
  RegisterRuntimeInput,
  UpdateCameraGroupInput,
  UpdateProcessingProfileInput,
  UpdateRuntimeInput,
  type AssignmentState,
} from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import { z } from 'zod';
import type { AssignmentService } from '../../application/assignment-service.js';
import type { Auth } from '../plugins/auth.js';
import { parseBody, success } from '../http.js';

export interface AssignmentRoutesDeps {
  assignments: AssignmentService;
  auth: Auth;
}

interface CameraParams {
  cameraId: string;
}

const EnableBody = z.object({
  profileId: z.string().min(1),
  runtimeId: z.string().min(1).optional(),
  note: z.string().max(500).optional(),
});

const AssignRuntimeBody = z.object({
  runtimeId: z.string().min(1).optional(),
  note: z.string().max(500).optional(),
});

const NoteBody = z.object({ note: z.string().max(500).optional() });

const ASSIGNMENT_STATES = [
  'unassigned',
  'assigned',
  'starting',
  'running',
  'paused',
  'stopping',
  'stopped',
  'error',
  'recovering',
] as const;

export function registerAssignmentRoutes(app: FastifyInstance, deps: AssignmentRoutesDeps): void {
  const { assignments, auth } = deps;
  const scopeOf = (request: { principal: { tenantId: string } | null }): TenantScope =>
    TenantScope.fromTenantId(request.principal!.tenantId);
  /* ⚠️ The actor on the audit record is the verified principal, never a body field. An audit trail
   * whose "who" can be supplied by the caller records what the caller wished to be recorded. */
  const actorOf = (request: { principal: { principalId: string } | null }): string =>
    request.principal?.principalId ?? 'unknown';

  // -------------------------------------------------------------------------------------------
  // Profiles (§2)
  // -------------------------------------------------------------------------------------------

  app.get(
    '/processing-profiles',
    { preHandler: auth.authorize('assignment:read') },
    async (request, reply) => reply.send(success(await assignments.listProfiles(scopeOf(request)))),
  );

  app.post(
    '/processing-profiles',
    { preHandler: auth.authorize('assignment:write') },
    async (request, reply) => {
      const input = parseBody(CreateProcessingProfileInput, request.body);
      const profile = await assignments.createProfile(scopeOf(request), input, actorOf(request));
      return reply.status(201).send(success(profile));
    },
  );

  app.get<{ Params: { profileId: string } }>(
    '/processing-profiles/:profileId',
    { preHandler: auth.authorize('assignment:read') },
    async (request, reply) =>
      reply.send(success(await assignments.getProfile(scopeOf(request), request.params.profileId))),
  );

  app.patch<{ Params: { profileId: string } }>(
    '/processing-profiles/:profileId',
    { preHandler: auth.authorize('assignment:write') },
    async (request, reply) => {
      const patch = parseBody(UpdateProcessingProfileInput, request.body);
      return reply.send(
        success(
          await assignments.updateProfile(
            scopeOf(request),
            request.params.profileId,
            patch,
            actorOf(request),
          ),
        ),
      );
    },
  );

  app.delete<{ Params: { profileId: string } }>(
    '/processing-profiles/:profileId',
    { preHandler: auth.authorize('assignment:write') },
    async (request, reply) => {
      await assignments.deleteProfile(scopeOf(request), request.params.profileId);
      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------------------------
  // Runtimes (§3)
  // -------------------------------------------------------------------------------------------

  app.get(
    '/processing-runtimes',
    { preHandler: auth.authorize('assignment:read') },
    async (_request, reply) => reply.send(success(await assignments.listRuntimes())),
  );

  app.post(
    '/processing-runtimes',
    { preHandler: auth.authorize('assignment:runtime') },
    async (request, reply) => {
      const input = parseBody(RegisterRuntimeInput, request.body);
      return reply
        .status(201)
        .send(success(await assignments.registerRuntime(input, actorOf(request))));
    },
  );

  app.get<{ Params: { runtimeId: string } }>(
    '/processing-runtimes/:runtimeId',
    { preHandler: auth.authorize('assignment:read') },
    async (request, reply) =>
      reply.send(success(await assignments.getRuntime(request.params.runtimeId))),
  );

  app.patch<{ Params: { runtimeId: string } }>(
    '/processing-runtimes/:runtimeId',
    { preHandler: auth.authorize('assignment:runtime') },
    async (request, reply) => {
      const patch = parseBody(UpdateRuntimeInput, request.body);
      return reply.send(
        success(await assignments.updateRuntime(request.params.runtimeId, patch, actorOf(request))),
      );
    },
  );

  app.delete<{ Params: { runtimeId: string } }>(
    '/processing-runtimes/:runtimeId',
    { preHandler: auth.authorize('assignment:runtime') },
    async (request, reply) =>
      reply.send(
        success(await assignments.removeRuntime(request.params.runtimeId, actorOf(request))),
      ),
  );

  // -------------------------------------------------------------------------------------------
  // Camera groups (§ rec 5) — storage only; nothing reads these to make a decision
  // -------------------------------------------------------------------------------------------

  app.get(
    '/camera-groups',
    { preHandler: auth.authorize('assignment:read') },
    async (request, reply) => reply.send(success(await assignments.listGroups(scopeOf(request)))),
  );

  app.post(
    '/camera-groups',
    { preHandler: auth.authorize('assignment:write') },
    async (request, reply) => {
      const input = parseBody(CreateCameraGroupInput, request.body);
      return reply
        .status(201)
        .send(success(await assignments.createGroup(scopeOf(request), input, actorOf(request))));
    },
  );

  app.patch<{ Params: { groupId: string } }>(
    '/camera-groups/:groupId',
    { preHandler: auth.authorize('assignment:write') },
    async (request, reply) => {
      const patch = parseBody(UpdateCameraGroupInput, request.body);
      return reply.send(
        success(
          await assignments.updateGroup(
            scopeOf(request),
            request.params.groupId,
            patch,
            actorOf(request),
          ),
        ),
      );
    },
  );

  app.delete<{ Params: { groupId: string } }>(
    '/camera-groups/:groupId',
    { preHandler: auth.authorize('assignment:write') },
    async (request, reply) => {
      await assignments.deleteGroup(scopeOf(request), request.params.groupId);
      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------------------------
  // Assignments — ⚠️ static paths first, see the header
  // -------------------------------------------------------------------------------------------

  app.get(
    '/assignments/capacity',
    { preHandler: auth.authorize('assignment:read') },
    async (request, reply) => reply.send(success(await assignments.capacity(scopeOf(request)))),
  );

  app.get<{ Querystring: { cameraId?: string; limit?: string } }>(
    '/assignments/history',
    { preHandler: auth.authorize('assignment:read') },
    async (request, reply) => {
      const limit = Number(request.query.limit ?? 50);
      return reply.send(
        success(
          await assignments.listHistory(scopeOf(request), {
            ...(request.query.cameraId === undefined ? {} : { cameraId: request.query.cameraId }),
            ...(Number.isFinite(limit) ? { limit } : {}),
          }),
        ),
      );
    },
  );

  app.post(
    '/assignments/bulk',
    { preHandler: auth.authorize('assignment:write') },
    async (request, reply) => {
      const input = parseBody(BulkAssignmentRequest, request.body);
      const result = await assignments.bulk(scopeOf(request), input, actorOf(request));
      /*
       * ⚠️ `207 Multi-Status` when the outcome is mixed, `200` otherwise. A partial failure returned
       * as a flat 200 is a partial failure nobody notices — the console's error handling keys off the
       * status before it reads the body, and so does every script anybody will write against this.
       */
      return reply.status(result.partial ? 207 : 200).send(success(result));
    },
  );

  app.get<{ Querystring: { state?: string; runtimeId?: string; profileId?: string } }>(
    '/assignments',
    { preHandler: auth.authorize('assignment:read') },
    async (request, reply) => {
      const state = ASSIGNMENT_STATES.find((s) => s === request.query.state);
      return reply.send(
        success(
          await assignments.listAssignments(scopeOf(request), {
            ...(state === undefined ? {} : { state: state as AssignmentState }),
            ...(request.query.runtimeId === undefined
              ? {}
              : { runtimeId: request.query.runtimeId }),
            ...(request.query.profileId === undefined
              ? {}
              : { profileId: request.query.profileId }),
          }),
        ),
      );
    },
  );

  /**
   * The camera capability matrix (§ rec 1) — the single read-only answer future modules consume.
   *
   * ⚠️ Declared under `/cameras/...` rather than `/assignments/...` because it is a property of the
   * camera, not of its assignment: a camera with no assignment still has a matrix, and it still says
   * `recording: true`. Filing it under assignment would have made "what can this camera do" a
   * question you can only ask about cameras somebody already assigned.
   */
  app.get<{ Params: CameraParams }>(
    '/cameras/:cameraId/capability-matrix',
    { preHandler: auth.authorize('assignment:read') },
    async (request, reply) =>
      reply.send(
        success(
          await assignments.capabilityMatrix(
            scopeOf(request),
            request.params.cameraId,
            /* ⚠️ The caller's own token, forwarded so the rule catalogue answers with THEIR
             * authority. A service credential here would silently widen every reader's access. */
            request.headers.authorization,
          ),
        ),
      ),
  );

  app.get<{ Params: CameraParams }>(
    '/assignments/:cameraId',
    { preHandler: auth.authorize('assignment:read') },
    async (request, reply) =>
      reply.send(
        success(await assignments.getAssignment(scopeOf(request), request.params.cameraId)),
      ),
  );

  app.post<{ Params: CameraParams }>(
    '/assignments/:cameraId/enable',
    { preHandler: auth.authorize('assignment:write') },
    async (request, reply) => {
      const body = parseBody(EnableBody, request.body ?? {});
      return reply.send(
        success(
          await assignments.enable(scopeOf(request), request.params.cameraId, {
            profileId: body.profileId,
            ...(body.runtimeId === undefined ? {} : { runtimeId: body.runtimeId }),
            ...(body.note === undefined ? {} : { note: body.note }),
            actor: actorOf(request),
          }),
        ),
      );
    },
  );

  app.post<{ Params: CameraParams }>(
    '/assignments/:cameraId/runtime',
    { preHandler: auth.authorize('assignment:write') },
    async (request, reply) => {
      const body = parseBody(AssignRuntimeBody, request.body ?? {});
      return reply.send(
        success(
          await assignments.assignRuntime(scopeOf(request), request.params.cameraId, {
            ...(body.runtimeId === undefined ? {} : { runtimeId: body.runtimeId }),
            ...(body.note === undefined ? {} : { note: body.note }),
            actor: actorOf(request),
          }),
        ),
      );
    },
  );

  /*
   * ⚠️ `pause` and `resume` take `assignment:control`; everything else takes `assignment:write`.
   * The two lists are written out rather than derived so adding an action cannot silently inherit the
   * weaker permission.
   */
  for (const action of ['disable', 'restart'] as const) {
    app.post<{ Params: CameraParams }>(
      `/assignments/:cameraId/${action}`,
      { preHandler: auth.authorize('assignment:write') },
      async (request, reply) => {
        const body = parseBody(NoteBody, request.body ?? {});
        return reply.send(
          success(
            await assignments.act(scopeOf(request), request.params.cameraId, action, {
              actor: actorOf(request),
              ...(body.note === undefined ? {} : { note: body.note }),
            }),
          ),
        );
      },
    );
  }

  for (const action of ['pause', 'resume'] as const) {
    app.post<{ Params: CameraParams }>(
      `/assignments/:cameraId/${action}`,
      { preHandler: auth.authorize('assignment:control') },
      async (request, reply) => {
        const body = parseBody(NoteBody, request.body ?? {});
        return reply.send(
          success(
            await assignments.act(scopeOf(request), request.params.cameraId, action, {
              actor: actorOf(request),
              ...(body.note === undefined ? {} : { note: body.note }),
            }),
          ),
        );
      },
    );
  }

  app.delete<{ Params: CameraParams }>(
    '/assignments/:cameraId',
    { preHandler: auth.authorize('assignment:write') },
    async (request, reply) =>
      reply.send(
        success(
          await assignments.act(scopeOf(request), request.params.cameraId, 'remove', {
            actor: actorOf(request),
          }),
        ),
      ),
  );
}
