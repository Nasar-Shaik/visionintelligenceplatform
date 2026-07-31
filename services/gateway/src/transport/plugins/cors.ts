/**
 * Minimal, explicit CORS for the browser console (P2-2 G-5). Hand-rolled (no new dependency, in
 * keeping with the platform's lean ethos) and fail-closed: an origin is reflected ONLY if it is on
 * the configured allowlist; anything else gets no CORS headers (the browser blocks it). Credentials
 * are allowed so the console can carry its bearer token on the SSE request. Preflight (`OPTIONS`) is
 * answered 204 without hitting a route.
 */
import type { FastifyInstance } from 'fastify';

export interface CorsOptions {
  allowedOrigins: string[];
}

const ALLOW_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const ALLOW_HEADERS = 'authorization,content-type,x-tenant-id,x-request-id,last-event-id';

export function registerCors(app: FastifyInstance, opts: CorsOptions): void {
  const allowed = new Set(opts.allowedOrigins);
  if (allowed.size === 0) return; // same-origin only — no CORS headers emitted

  app.addHook('onRequest', (request, reply, done) => {
    const origin = request.headers.origin;
    if (typeof origin === 'string' && allowed.has(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
      reply.header('access-control-allow-credentials', 'true');
      reply.header('access-control-expose-headers', 'x-request-id');
    }
    if (request.method === 'OPTIONS') {
      reply.header('access-control-allow-methods', ALLOW_METHODS);
      reply.header('access-control-allow-headers', ALLOW_HEADERS);
      reply.header('access-control-max-age', '600');
      // Preflight ends here whether or not the origin was allowed (no body).
      reply.code(204).send();
      return;
    }
    done();
  });
}
