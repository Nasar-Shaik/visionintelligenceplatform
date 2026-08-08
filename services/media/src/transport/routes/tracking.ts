/**
 * Transport: the operator's view of object tracking (P-8 Phase 4).
 *
 *   GET /perception/tracking                    aggregate statistics for the caller's tenant
 *   GET /perception/tracking/cameras            the same metrics, per camera
 *   GET /perception/tracking/tracks             live tracks (?cameraId= &state=)
 *   GET /perception/tracking/tracks/:trackId    one track plus its lifecycle timeline
 *   GET /perception/behaviour                   the behaviour stage's state (?cameraId= &streamId=)
 *   GET /perception/track-history               stored movement paths (?cameraId= &identityId=)
 *
 * ### ⚠️ Why this lives in media, like the runtime view above it
 *
 * The AI runtime is **not routed through the gateway** and P-8 Phase 1 asserts that as a deployment
 * property. Media is the one service that talks to it (ADR-A: media pushes frames), so media is the
 * one service that can answer questions about it without opening a second door. The console reaches
 * this through the gateway's `/api/tracking/*`, which fans out to here.
 *
 * ### ⚠️ This is TENANT DATA, and that makes it different from `/perception/runtime`
 *
 * The runtime view carries counts, states and versions — the same for every tenant. A **track** is a
 * record of a person moving through a customer's premises. So:
 *
 *   - the permission is `track:read`, not `system:inspect`;
 *   - the tenant sent to the runtime comes from the **verified access token** and from nowhere else.
 *     ⚠️ Never from a header, a query parameter or a body field. A caller who can name their own
 *     tenant can read every tenant, and the runtime — which sits behind a shared internal key and
 *     trusts whatever `x-tenant-id` it is handed — would answer without complaint.
 *
 * ### ⚠️ Read-only, and there is nothing here to make it otherwise
 *
 * No route starts, stops, resets or reassigns a track. Tracking is a consequence of frames arriving,
 * not something an operator steers; a control that configured nothing would be worse than none.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Auth } from '../plugins/auth.js';
import { success } from '../http.js';

/** Wall-clock ceiling on the runtime hop. A slow runtime is a degraded page, not a hung one. */
const TRACKING_TIMEOUT_MS = 3_000;

export interface TrackingRoutesDeps {
  auth: Auth;
  /** Base URL of the runtime, or `''` when this deployment has no perception wiring. */
  runtimeUrl: string;
  internalKey: string;
  fetch?: typeof fetch;
}

export function registerTrackingRoutes(app: FastifyInstance, deps: TrackingRoutesDeps): void {
  const doFetch = deps.fetch ?? fetch;

  const proxy = async (request: FastifyRequest, path: string, query = ''): Promise<unknown> => {
    /*
     * ⚠️ The tenant is read off the principal the auth plugin verified. `request.principal` is
     * populated by `authorize()` having already checked the token signature, issuer and audience —
     * so this cannot be influenced by anything the browser chose to send.
     */
    const tenantId = request.principal?.tenantId;
    if (tenantId === undefined || tenantId === '') {
      return { enabled: false, detail: 'no tenant on the verified principal' };
    }
    if (deps.runtimeUrl === '') {
      return {
        enabled: false,
        detail: 'INFERENCE_URL is not set in this deployment, so nothing is tracked.',
      };
    }
    const base = deps.runtimeUrl.replace(/\/+$/, '');
    const response = await doFetch(`${base}${path}${query}`, {
      signal: AbortSignal.timeout(TRACKING_TIMEOUT_MS),
      headers: {
        accept: 'application/json',
        'x-internal-key': deps.internalKey,
        'x-tenant-id': tenantId,
      },
    });
    const body = (await response.json()) as { data?: unknown; error?: { message?: string } };
    if (!response.ok) {
      /*
       * ⚠️ 404 is forwarded as a null result rather than raised. "This track is not live any more"
       * is an ordinary answer for a page watching a moving scene — a track that ended between the
       * list request and the detail request is the normal case, not an error worth a red banner.
       */
      if (response.status === 404) return null;
      throw new Error(body.error?.message ?? `runtime answered HTTP ${response.status}`);
    }
    return body.data ?? null;
  };

  app.get(
    '/perception/tracking',
    { preHandler: deps.auth.authorize('track:read') },
    async (request, reply) =>
      reply.send(success(await unreachableAsAnswer(() => proxy(request, '/tracking')))),
  );

  /*
   * ⚠️ `track:read`, the same permission as the tracks themselves, and deliberately not a weaker
   * one. A per-camera row names a camera and says how many people it has seen — that is tenant
   * data about a customer's premises, and a caller who may not read tracks may not read this
   * either. It is the surface Camera Processing Assignment will build on, so the permission it
   * inherits is the one that has to be right now rather than later.
   */
  app.get(
    '/perception/tracking/cameras',
    { preHandler: deps.auth.authorize('track:read') },
    async (request, reply) =>
      reply.send(success(await unreachableAsAnswer(() => proxy(request, '/tracking/cameras')))),
  );

  app.get<{ Querystring: { cameraId?: string; state?: string } }>(
    '/perception/tracking/tracks',
    { preHandler: deps.auth.authorize('track:read') },
    async (request, reply) => {
      const params = new URLSearchParams();
      if (request.query.cameraId !== undefined) params.set('cameraId', request.query.cameraId);
      if (request.query.state !== undefined) params.set('state', request.query.state);
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return reply.send(
        success(await unreachableAsAnswer(() => proxy(request, '/tracking/tracks', query))),
      );
    },
  );

  app.get<{ Params: { trackId: string } }>(
    '/perception/tracking/tracks/:trackId',
    { preHandler: deps.auth.authorize('track:read') },
    async (request, reply) => {
      const encoded = encodeURIComponent(request.params.trackId);
      const detail = await unreachableAsAnswer(() => proxy(request, `/tracking/tracks/${encoded}`));
      if (detail === null)
        return reply.status(404).send({
          success: false,
          error: { code: 'not_found', message: 'that track is no longer live' },
        });
      return reply.send(success(detail));
    },
  );

  /*
   * ⚠️ **`track:read`, the same permission as a track, and not a weaker one.** A behaviour primitive
   * is a statement about how a person moved — dwell, proximity, who they were near — which is more
   * revealing than the track it was derived from, never less. A separate, softer permission would be
   * the kind of mistake that only shows up in an audit.
   */
  app.get<{ Querystring: { cameraId?: string; streamId?: string } }>(
    '/perception/behaviour',
    { preHandler: deps.auth.authorize('track:read') },
    async (request, reply) => {
      const params = new URLSearchParams();
      if (request.query.cameraId !== undefined) params.set('cameraId', request.query.cameraId);
      if (request.query.streamId !== undefined) params.set('streamId', request.query.streamId);
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return reply.send(
        success(await unreachableAsAnswer(() => proxy(request, '/tracking/behaviour', query))),
      );
    },
  );

  /*
   * ⚠️ Stored movement paths (ADR-0051). Read-only here, deliberately: **erasure is not a console
   * button.** A tenant-scoped delete must remove history alongside the incidents that cite it, and a
   * control that removed one and left the other would answer "deleted" while the evidence trail
   * still named the person. The runtime's `DELETE /tracking/history` exists and is verified; joining
   * it to platform-wide tenant deletion is recorded as a remaining blocker rather than half-wired.
   */
  app.get<{ Querystring: { cameraId?: string; identityId?: string; streamId?: string } }>(
    '/perception/track-history',
    { preHandler: deps.auth.authorize('track:read') },
    async (request, reply) => {
      const params = new URLSearchParams();
      for (const key of ['cameraId', 'identityId', 'streamId'] as const) {
        const value = request.query[key];
        if (value !== undefined) params.set(key, value);
      }
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return reply.send(
        success(await unreachableAsAnswer(() => proxy(request, '/tracking/history', query))),
      );
    },
  );
}

/**
 * ⚠️ An unreachable runtime is **the answer this page exists to give**, not a 500.
 *
 * The same reasoning as `probeRuntime` in perception.ts: "the runtime is not answering" is a
 * deployment fact the operator needs to see, and "internal server error" sends them looking at the
 * wrong service. The reason is carried through so the page can name it.
 */
async function unreachableAsAnswer(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    return {
      enabled: false,
      unreachable: true,
      detail: timedOut
        ? `the runtime did not answer within ${TRACKING_TIMEOUT_MS} ms`
        : reasonFor(err),
    };
  }
}

/**
 * ⚠️ "fetch failed" is not a reason — the finding P-6.4 recorded and perception.ts repeats.
 * `undici` puts the real cause one level down, and `ECONNREFUSED` versus `ENOTFOUND` is the
 * difference between "the container is not running" and "the name does not resolve".
 */
function reasonFor(err: unknown): string {
  if (!(err instanceof Error)) return 'the runtime could not be reached';
  const cause = err.cause as { code?: unknown; message?: unknown } | undefined;
  const reason = typeof cause?.code === 'string' ? cause.code : cause?.message;
  return (reason === undefined ? err.message : `${err.message} (${String(reason)})`).slice(0, 300);
}
