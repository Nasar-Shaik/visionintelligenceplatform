/**
 * Transport: **live frame ingest** (P-9). A capture agent opens a session for a camera, posts
 * frames, and closes it.
 *
 * ### ⚠️ Why the frame is base64 in JSON rather than a raw body
 *
 * A raw `image/jpeg` body is a third smaller and would need a content-type parser this service does
 * not otherwise have, on a path that crosses the gateway. Base64 in JSON survives any proxy that
 * re-serialises, matches how the runtime's own `/infer` takes an image, and costs ~33 % of a payload
 * that is already small. ⚠️ The cost is real and is recorded in the validation rather than hidden:
 * at 4 fps and 640×480 it is roughly 0.3 MB/s per camera.
 *
 * ### Permissions
 *
 * Ingest writes into the perception path for a camera, so it rides `stream:control` — the same
 * permission as starting and stopping that camera's stream. Reading session state is `stream:read`.
 */
import type { FastifyInstance } from 'fastify';
import type { LiveIngest } from '../../application/live-ingest.js';
import type { Auth } from '../plugins/auth.js';
import { success } from '../http.js';

export interface LiveRoutesDeps {
  ingest: LiveIngest;
  auth: Auth;
}

interface CameraParams {
  cameraId: string;
}

interface OpenBody {
  frameRate?: number;
  width?: number;
  height?: number;
  agent?: string;
}

interface FrameBody {
  /** Base64 JPEG. */
  image?: string;
  /** ⚠️ Epoch ms from the agent. Used ONLY to measure latency — never as the frame's time. */
  capturedAtMs?: number;
}

export function registerLiveRoutes(app: FastifyInstance, deps: LiveRoutesDeps): void {
  const { ingest, auth } = deps;
  const tenantOf = (request: { principal: { tenantId: string } | null }): string =>
    request.principal!.tenantId;

  /** Every live ingest session this tenant has open. */
  app.get('/live/sessions', { preHandler: auth.authorize('stream:read') }, async (request, reply) =>
    reply.send(success(ingest.list(tenantOf(request)))),
  );

  app.post<{ Params: CameraParams; Body: OpenBody }>(
    '/live/:cameraId/open',
    { preHandler: auth.authorize('stream:control') },
    async (request, reply) => {
      const body = request.body ?? {};
      return reply.send(
        success(
          ingest.open({
            tenantId: tenantOf(request),
            cameraId: request.params.cameraId,
            frameRate: body.frameRate ?? 4,
            width: body.width,
            height: body.height,
            agent: body.agent,
          }),
        ),
      );
    },
  );

  /*
   * ⚠️ **A 200 means "accepted for perception", not "analysed".** `FrameSink.push` is
   * fire-and-forget by contract: it never awaits and absorbs a slow runtime by dropping frames. So
   * the response carries the sequence number and the transport lag, and deliberately does not carry
   * a detection count — which would be a promise this path cannot keep. Detections arrive on the
   * event stream, which is where a live consumer should be looking anyway.
   */
  app.post<{ Params: CameraParams; Body: FrameBody }>(
    '/live/:cameraId/frame',
    {
      preHandler: auth.authorize('stream:control'),
      /* One 640×480 JPEG base64-encoded is ~80 KB; 2 MB is generous and bounds a hostile client. */
      bodyLimit: 2 * 1024 * 1024,
    },
    async (request, reply) => {
      const body = request.body ?? {};
      const image = typeof body.image === 'string' ? body.image : '';
      const data = Buffer.from(image, 'base64');
      return reply.send(
        success(
          ingest.frame(
            tenantOf(request),
            request.params.cameraId,
            new Uint8Array(data),
            typeof body.capturedAtMs === 'number' ? body.capturedAtMs : undefined,
          ),
        ),
      );
    },
  );

  app.post<{ Params: CameraParams }>(
    '/live/:cameraId/close',
    { preHandler: auth.authorize('stream:control') },
    async (request, reply) =>
      reply.send(success(ingest.close(tenantOf(request), request.params.cameraId))),
  );

  /**
   * The held frame nearest an instant — evidence for a live incident.
   *
   * ⚠️ 404 rather than a nearby frame when nothing is within tolerance. Handing back the closest
   * frame at any distance would let a caller present a different moment as the moment in question,
   * which is the one thing an evidence path may never do.
   */
  app.get<{ Params: CameraParams; Querystring: { atMs?: string } }>(
    '/live/:cameraId/snapshot',
    { preHandler: auth.authorize('stream:read') },
    async (request, reply) => {
      const atMs = Number(request.query.atMs ?? Date.now());
      const shot = ingest.nearestFrame(tenantOf(request), request.params.cameraId, atMs);
      if (shot === undefined) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'not_found',
            message: 'no ingested frame is held within tolerance of that instant',
          },
        });
      }
      return reply
        .header('content-type', 'image/jpeg')
        .header('x-frame-seq', String(shot.seq))
        .header('x-frame-at', shot.at)
        .header('x-frame-delta-ms', String(shot.deltaMs))
        .send(Buffer.from(shot.data));
    },
  );
}
