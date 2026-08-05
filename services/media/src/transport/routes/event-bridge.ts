/**
 * Transport: the operator's view of the **Event Publisher bridge** (P-8 Phase 5).
 *
 *   GET /perception/event-bridge    what the bridge is doing right now
 *
 * ### ⚠️ Why this is `system:inspect` and not `track:read`
 *
 * Unlike `/perception/tracking`, this carries **no tenant data**: counts, timings, versions and a
 * broker state, identical for every tenant. It is the same engineering view as `/perception/runtime`
 * and is governed by the same permission. ⚠️ `lastPublishedCamera` is the one field that would name
 * a customer's camera, so it is deliberately **not** forwarded — see below.
 *
 * ### ⚠️ Read-only, and there is nothing here to make it otherwise
 *
 * No route starts, stops, drains, flushes or reconfigures the publisher. Publishing is a consequence
 * of frames arriving, not something an operator steers. A "flush queue" button would be a control
 * over a queue that is already draining as fast as the broker allows.
 */
import type { FastifyInstance } from 'fastify';
import type { Auth } from '../plugins/auth.js';
import { success } from '../http.js';
import type { EventPublisherStats } from '../../adapters/event-publisher.js';

export interface EventBridgeRoutesDeps {
  auth: Auth;
  /** Absent when the bridge is not enabled in this deployment. */
  publisher?: { stats(): EventPublisherStats };
}

export function registerEventBridgeRoutes(app: FastifyInstance, deps: EventBridgeRoutesDeps): void {
  app.get(
    '/perception/event-bridge',
    { preHandler: deps.auth.authorize('system:inspect') },
    async (_request, reply) => {
      if (deps.publisher === undefined) {
        /*
         * ⚠️ A first-class answer, not an omission. `MEDIA_EVENT_BRIDGE_ENABLED=0` is a valid
         * deployment, and the page must say "not enabled here" rather than render zeroes that look
         * exactly like "the broker is down and nothing has published".
         */
        return reply.send(
          success({
            enabled: false,
            detail: 'the event bridge is not enabled in this deployment',
          }),
        );
      }
      const stats = deps.publisher.stats();
      /*
       * ⚠️ `lastPublishedCamera` is dropped here on purpose. Every other field is a count, a timing
       * or a version — the same for every tenant. A camera id is not: it names a customer's premises,
       * and this route is behind an engineering permission rather than a tenant-scoped one. The
       * *timestamp* is kept, because "when did anything last publish" is the question this page
       * exists to answer and it identifies nobody.
       */
      const safe = { ...stats };
      delete safe.lastPublishedCamera;
      return reply.send(success(safe));
    },
  );
}
