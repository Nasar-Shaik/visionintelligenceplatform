/**
 * Transport: the gateway surface. `/whoami` proves edge validation + context resolution;
 * `/api/:service/*` validates the token then reverse-proxies to the upstream service, injecting
 * the trusted TenantContext headers and stripping any client-supplied ones. JSON bodies only in
 * P1-2 (streaming/multipart is a later extension).
 */
import type { FastifyInstance } from 'fastify';
import type { JwtOptions } from '@vip/auth';
import { authenticateRequest } from '../edge-auth.js';
import { buildPublicUpstreamHeaders, buildUpstreamHeaders } from '../context.js';
import { badGateway, notFound } from '../../application/errors.js';

export interface GatewayRoutesDeps {
  jwt: JwtOptions;
  upstreams: Record<string, string>;
}

/**
 * Public authentication bootstrap endpoints — proxied WITHOUT an access token, because they are how
 * a client obtains one. Restricted to identity's login/refresh/logout POSTs. Credentials (login) and
 * the opaque refresh token (refresh/logout) are still verified by the identity service; the gateway
 * only relaxes the edge token check and forwards `x-tenant-id` (a lookup scope) for these paths.
 */
const PUBLIC_AUTH_PATHS = new Set(['/auth/login', '/auth/refresh', '/auth/logout']);

function isPublicAuthPath(service: string, rest: string, method: string): boolean {
  if (service !== 'identity' || method !== 'POST') return false;
  const path = rest.split('?')[0] ?? rest;
  return PUBLIC_AUTH_PATHS.has(path);
}

export function registerGatewayRoutes(app: FastifyInstance, deps: GatewayRoutesDeps): void {
  app.get('/whoami', async (request, reply) => {
    const claims = await authenticateRequest(request, deps.jwt);
    return reply.send({
      success: true,
      data: {
        principalId: claims.principalId,
        tenantId: claims.tenantId,
        email: claims.email,
        roles: claims.roles,
      },
    });
  });

  app.all('/api/:service/*', async (request, reply) => {
    const { service } = request.params as { service: string };
    const base = deps.upstreams[service];
    if (!base) throw notFound(`unknown upstream service: ${service}`);

    // Rebuild the upstream URL: strip the `/api/<service>` prefix, keep the rest + query.
    const rest = request.url.slice(`/api/${service}`.length) || '/';
    const target = base.replace(/\/$/, '') + rest;

    // Public auth bootstrap (login/refresh/logout) is proxied without a token; everything else
    // requires a valid access token, whose claims become the trusted upstream context.
    const headers = isPublicAuthPath(service, rest, request.method)
      ? buildPublicUpstreamHeaders(request.headers)
      : buildUpstreamHeaders(request.headers, await authenticateRequest(request, deps.jwt));

    /**
     * ⚠️ Carry the correlation id across the hop. Every service already honours an inbound
     * `x-request-id` in `genReqId` — the gateway simply never sent one, so a single operator action
     * produced two unrelated ids in two log streams and could not be traced end to end. Measured in
     * P-5.8: the gateway logged `af4c8534…` for a request that workflow logged as `837cb352…`.
     *
     * The value is `request.id`, minted here (the edge strips any client-supplied one), so the id in
     * every downstream log is the same id returned to the caller as `correlationId` on an error.
     */
    headers['x-request-id'] = String(request.id);
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.body != null;
    const init: RequestInit = { method: request.method, headers };
    if (hasBody) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(request.body);
    }

    let upstream: Response;
    try {
      upstream = await fetch(target, init);
    } catch (err) {
      request.log.error({ err, target }, 'upstream request failed');
      throw badGateway();
    }

    reply.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) reply.header('content-type', contentType);

    /*
     * ⛔ **This used to be `await upstream.text()`, and it silently corrupted every binary body.**
     *
     * `.text()` decodes the response as UTF-8. For JSON that is correct and it is all this proxy
     * carried for eight milestones. The first binary payload to cross it — a live evidence frame in
     * P-9 — arrived as a **188 133-byte** response to a **104 803-byte** JPEG: every byte ≥ 0x80
     * re-encoded as a two-byte sequence, and every invalid sequence replaced with U+FFFD. The image
     * still began `FFD8FF`, so it still looked like a JPEG to anything checking the magic number,
     * and it would not open.
     *
     * ⚠️ Nothing failed and nothing logged. A corrupted evidence image is worse than a missing one:
     * a customer downloads it, cannot open it, and the platform's own records say it was served.
     *
     * Bytes are forwarded as bytes. JSON is bytes too, so the JSON path is unchanged — Fastify sends
     * a Buffer verbatim, and the `content-type` copied above is what tells the client how to read
     * it. `x-frame-*` headers are forwarded below for the same reason.
     */
    for (const name of ['x-frame-seq', 'x-frame-at', 'x-frame-delta-ms', 'content-disposition']) {
      const value = upstream.headers.get(name);
      if (value !== null) reply.header(name, value);
    }
    return reply.send(Buffer.from(await upstream.arrayBuffer()));
  });
}
