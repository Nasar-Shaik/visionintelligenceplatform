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
import type { FastifyInstance } from 'fastify';
import type { JwtOptions } from '@vip/auth';
import { principalCan } from '@vip/permissions';
import { authenticateRequest } from '../edge-auth.js';
import { forbidden } from '../../application/errors.js';
import type { SystemHealthService } from '../../application/system-health.js';

/** The upstream prefix this route occupies. An upstream may not claim it. */
export const RESERVED_PREFIX = 'system';

/**
 * ⚠️ Fails the boot if an upstream is named `system`, because the failure mode otherwise is a route
 * that half-works: the health path answers here and every sibling path proxies elsewhere.
 */
export function assertSystemPrefixFree(upstreams: Record<string, string>): void {
  if (RESERVED_PREFIX in upstreams) {
    throw new Error(
      `gateway: "${RESERVED_PREFIX}" is a reserved route prefix (/api/${RESERVED_PREFIX}/health) ` +
        'and cannot also be an upstream service name',
    );
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
  app.get('/api/system/ai-runtime', async (request, reply) => {
    const claims = await authenticateRequest(request, deps.jwt);
    if (!principalCan(claims, 'system:inspect')) {
      throw forbidden('not permitted to view the AI runtime');
    }
    /*
     * ⚠️ The caller's own token is forwarded. Media authorises the request independently — the
     * gateway does not vouch for a principal it already checked, because a service-to-service key
     * here would be a hidden privilege escalation: every console user would reach media's
     * perception view with the gateway's authority instead of their own.
     */
    const authorization = request.headers.authorization;
    try {
      const response = await doFetch(`${deps.mediaUrl.replace(/\/$/, '')}/perception/runtime`, {
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
            : 'media is not reachable, so the AI runtime cannot be inspected',
        },
      });
    }
  });
}
