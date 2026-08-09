/**
 * Transport: the platform's view of itself (P-6.4).
 *
 *   GET /api/system/health  — every service's readiness, the infrastructure derived from it, and
 *                             the capabilities this release does not have.
 *
 * ### ⚠️ `system` is a reserved prefix, and that is enforced rather than remembered
 *
 * This route is a static path sitting beside the proxy's `/api/:service/*`. Fastify prefers the
 * static segment, so it wins — but only while no upstream is *named* `system`, at which point
 * `/api/system/health` would answer here and `/api/system/anything-else` would proxy to a different
 * process. `assertSystemPrefixFree` fails the boot rather than leaving that to be discovered.
 *
 * ### ⚠️ The permission is `system:inspect`, and the spelling was a real finding
 *
 * `system:read` was written first. It is wrong in **both directions at once**: `*:read` would hand
 * the deployment's component and dependency topology to every `viewer`, and `admin` — which holds no
 * `*:read` — would be **refused a page its own operators could see**. The route test caught the
 * second half before anyone reasoned about the first. `inspect`, for the same reason
 * `audit:inspect` is not `audit:read` (TD-26).
 *
 * Granted to `admin` and `operator`; `owner` holds it through `*`. The payload carries no addresses,
 * no credentials and no versions — component names, states, and the dependency-check names the
 * services already report about themselves.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { JwtOptions } from '@vip/auth';
import { principalCan } from '@vip/permissions';
import { authenticateRequest } from '../edge-auth.js';
import { forbidden } from '../../application/errors.js';
import type { SystemHealthService } from '../../application/system-health.js';

/**
 * The upstream prefixes these routes occupy. An upstream may not claim either.
 *
 * ⚠️ `tracking` joined `system` in P-8 Phase 4 for exactly the same reason: `/api/tracking/*` is a
 * static path beside the proxy's `/api/:service/*`, so an upstream named `tracking` would make
 * `/api/tracking/tracks` answer here while `/api/tracking/anything-else` proxied to a different
 * process — a route that half-works, which is worse than one that does not.
 */
export const RESERVED_PREFIX = 'system';
export const RESERVED_PREFIXES = ['system', 'tracking'] as const;

/**
 * ⚠️ Fails the boot if an upstream is named `system`, because the failure mode otherwise is a route
 * that half-works: the health path answers here and every sibling path proxies elsewhere.
 */
export function assertSystemPrefixFree(upstreams: Record<string, string>): void {
  for (const prefix of RESERVED_PREFIXES) {
    if (prefix in upstreams) {
      throw new Error(
        `gateway: "${prefix}" is a reserved route prefix (/api/${prefix}/…) ` +
          'and cannot also be an upstream service name',
      );
    }
  }
}

export interface SystemRoutesDeps {
  jwt: JwtOptions;
  health: SystemHealthService;
  /** Media's base URL — the only service permitted to talk to the AI runtime. */
  mediaUrl: string;
  fetch?: typeof fetch;
}

/** Wall-clock ceiling on the media hop. A slow answer is a degraded page, not a hung one. */
const AI_RUNTIME_TIMEOUT_MS = 4_000;

export function registerSystemRoutes(app: FastifyInstance, deps: SystemRoutesDeps): void {
  const doFetch = deps.fetch ?? fetch;

  app.get('/api/system/health', async (request, reply) => {
    const claims = await authenticateRequest(request, deps.jwt);
    if (!principalCan(claims, 'system:inspect')) {
      throw forbidden('not permitted to view system health');
    }
    return reply.send({ success: true, data: await deps.health.report() });
  });

  /**
   * The AI runtime's engineering view (P-8 Phase 3).
   *
   * ⚠️ **Proxied through media on purpose.** The runtime is not an upstream and P-8 Phase 1 asserts
   * that as a deployment property — no `/api/inference/*`, nothing routed, no browser-reachable
   * path to it. Media is the one service that talks to it (ADR-A), so the console's question goes
   * gateway → media → runtime and the boundary stays exactly where it was verified.
   *
   * ⚠️ Same permission as System Health, for the same reason: this is deployment state, identical
   * for every tenant, carrying no tenant data. `inspect`, not `read` (TD-26).
   */
  app.get('/api/system/ai-runtime', async (request, reply) =>
    mediaInspect(request, reply, '/perception/runtime', 'the AI runtime'),
  );

  /**
   * The Event Publisher bridge (P-8 Phase 5).
   *
   * ⚠️ Same path, same permission and same reasoning as the AI runtime view above: deployment state,
   * identical for every tenant, carrying no tenant data. It goes gateway → media because media owns
   * the publisher, exactly as it owns the perception seam.
   */
  app.get('/api/system/event-bridge', async (request, reply) =>
    mediaInspect(request, reply, '/perception/event-bridge', 'the event bridge'),
  );

  async function mediaInspect(
    request: FastifyRequest,
    reply: FastifyReply,
    path: string,
    what: string,
  ): Promise<unknown> {
    const claims = await authenticateRequest(request, deps.jwt);
    if (!principalCan(claims, 'system:inspect')) {
      throw forbidden(`not permitted to view ${what}`);
    }
    /*
     * ⚠️ The caller's own token is forwarded. Media authorises the request independently — the
     * gateway does not vouch for a principal it already checked, because a service-to-service key
     * here would be a hidden privilege escalation: every console user would reach media's
     * perception view with the gateway's authority instead of their own.
     */
    const authorization = request.headers.authorization;
    try {
      const response = await doFetch(`${deps.mediaUrl.replace(/\/$/, '')}${path}`, {
        signal: AbortSignal.timeout(AI_RUNTIME_TIMEOUT_MS),
        headers: {
          accept: 'application/json',
          ...(typeof authorization === 'string' ? { authorization } : {}),
        },
      });
      const body = await response.text();
      return reply.status(response.status).header('content-type', 'application/json').send(body);
    } catch (err) {
      /*
       * ⚠️ 503 with a reason, not 500. Media being unreachable is a deployment fact the page is
       * built to display; "internal server error" would send the operator looking at the gateway.
       */
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      return reply.status(503).send({
        success: false,
        error: {
          code: 'upstream_unavailable',
          message: timedOut
            ? `media did not answer within ${AI_RUNTIME_TIMEOUT_MS} ms`
            : `media is not reachable, so ${what} cannot be inspected`,
        },
      });
    }
  }

  /**
   * Object tracking (P-8 Phase 4).
   *
   *   GET /api/tracking                    aggregate statistics
   *   GET /api/tracking/cameras            the same metrics, per camera
   *   GET /api/tracking/tracks             live tracks
   *   GET /api/tracking/tracks/:trackId    one track plus its lifecycle
   *
   * ⚠️ Proxied through media for the same reason as the AI runtime view: the runtime is not an
   * upstream, and P-8 Phase 1 asserts that as a deployment property.
   *
   * ⚠️ **No permission check here, and that is deliberate.** Media authorises `track:read`
   * independently against the caller's own token, which is forwarded unchanged. Checking here as
   * well would be defence in depth if it were free — but the failure mode of a *second* copy is
   * drift: two places to update when the permission changes, and the one that is forgotten becomes
   * either a leak or a lockout. The gateway does not vouch for a principal, and it never substitutes
   * a service key for one, because that would be a hidden privilege escalation.
   */
  const perceptionProxy = async (
    request: FastifyRequest,
    reply: FastifyReply,
    path: string,
  ): Promise<unknown> => {
    const authorization = request.headers.authorization;
    const search = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
    try {
      const response = await doFetch(
        `${deps.mediaUrl.replace(/\/$/, '')}${path}${search}`,
        {
          signal: AbortSignal.timeout(AI_RUNTIME_TIMEOUT_MS),
          headers: {
            accept: 'application/json',
            ...(typeof authorization === 'string' ? { authorization } : {}),
          },
        },
      );
      const body = await response.text();
      return reply.status(response.status).header('content-type', 'application/json').send(body);
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      return reply.status(503).send({
        success: false,
        error: {
          code: 'upstream_unavailable',
          message: timedOut
            ? `media did not answer within ${AI_RUNTIME_TIMEOUT_MS} ms`
            : 'media is not reachable, so tracking cannot be read',
        },
      });
    }
  };

  const trackingProxy = async (
    request: FastifyRequest,
    reply: FastifyReply,
    path: string,
  ): Promise<unknown> => perceptionProxy(request, reply, `/perception/tracking${path}`);

  app.get('/api/tracking', async (request, reply) => trackingProxy(request, reply, ''));
  app.get('/api/tracking/cameras', async (request, reply) =>
    trackingProxy(request, reply, '/cameras'),
  );
  app.get('/api/tracking/tracks', async (request, reply) =>
    trackingProxy(request, reply, '/tracks'),
  );
  app.get<{ Params: { trackId: string } }>(
    '/api/tracking/tracks/:trackId',
    async (request, reply) =>
      trackingProxy(request, reply, `/tracks/${encodeURIComponent(request.params.trackId)}`),
  );

  /*
   * Behaviour primitives + stored movement paths (P-11 slice 2.2).
   *
   *   GET /api/behaviour             the behaviour stage's state and recent scene-level statements
   *   GET /api/behaviour/primitives  every primitive of an analysis, recomputed (slice 2.3)
   *   GET /api/behaviour/timeline    the same facts as an ordered account (slice 2.3)
   *   GET /api/behaviour/graph       the same facts again, as nodes and edges (slice 2.6)
   *   GET /api/track-history         stored movement paths for the caller's tenant (ADR-0051)
   *
   * ⚠️ Same proxy, same absent permission check, same reason: media authorises `track:read` against
   * the caller's own forwarded token, and a second copy here would be a second thing to keep true.
   * ⚠️ No `DELETE`. Erasure must remove history alongside the incidents that cite it, and a route
   * that did half of that would report success while the evidence trail still named the person.
   */
  app.get('/api/behaviour', async (request, reply) =>
    perceptionProxy(request, reply, '/perception/behaviour'),
  );
  app.get('/api/behaviour/primitives', async (request, reply) =>
    perceptionProxy(request, reply, '/perception/behaviour/primitives'),
  );
  app.get('/api/behaviour/timeline', async (request, reply) =>
    perceptionProxy(request, reply, '/perception/behaviour/timeline'),
  );
  /* ⭐ A third projection of one computation, not a third computation — see `behaviour_graph.py`. */
  app.get('/api/behaviour/graph', async (request, reply) =>
    perceptionProxy(request, reply, '/perception/behaviour/graph'),
  );
  app.get('/api/track-history', async (request, reply) =>
    perceptionProxy(request, reply, '/perception/track-history'),
  );
}
