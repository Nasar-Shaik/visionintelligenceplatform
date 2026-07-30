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
    return reply.send(await upstream.text());
  });
}
