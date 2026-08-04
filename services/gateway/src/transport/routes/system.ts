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
}

export function registerSystemRoutes(app: FastifyInstance, deps: SystemRoutesDeps): void {
  app.get('/api/system/health', async (request, reply) => {
    const claims = await authenticateRequest(request, deps.jwt);
    if (!principalCan(claims, 'system:inspect')) {
      throw forbidden('not permitted to view system health');
    }
    return reply.send({ success: true, data: await deps.health.report() });
  });
}
