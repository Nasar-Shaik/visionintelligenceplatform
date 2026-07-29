/**
 * Transport: access-token authentication + permission authorization. The notify service is a
 * downstream context that verifies the Bearer access token minted by identity (defence-in-depth:
 * it does not blindly trust gateway-forwarded headers). `createAuth` builds `authenticate` (verify
 * the token via @vip/auth, attach the principal) and `authorize(permission)` (authenticate, then
 * gate via the @vip/permissions PDP, deny-by-default). Injected into the routes that need them.
 *
 * The expected issuer/audience MUST match what identity signs with (`iss=identity`, `aud=vip`) —
 * same as the gateway's edge verification (AUTHENTICATION.md). An RS256/JWKS split is a later swap.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { AuthError, verifyAccessToken } from '@vip/auth';
import { principalCan } from '@vip/permissions';
import { forbidden } from '../../application/errors.js';

export interface AuthPrincipal {
  principalId: string;
  tenantId: string;
  email: string;
  roles: string[];
}

export interface AuthPluginOptions {
  secret: string;
  /** Expected token issuer — identity's service name. */
  issuer?: string;
  /** Expected token audience. */
  audience?: string;
}

export interface Auth {
  authenticate: preHandlerHookHandler;
  authorize: (permission: string) => preHandlerHookHandler;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: AuthPrincipal | null;
  }
}

/** Decorate the request with a null `principal` slot (populated by `authenticate`). */
export function registerPrincipal(app: FastifyInstance): void {
  app.decorateRequest('principal', null);
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  return null;
}

export function createAuth(opts: AuthPluginOptions): Auth {
  const authenticate = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = bearerToken(request);
    if (!token) throw new AuthError('missing bearer token');
    const claims = await verifyAccessToken(token, opts);
    request.principal = {
      principalId: claims.principalId,
      tenantId: claims.tenantId,
      email: claims.email,
      roles: claims.roles,
    };
  };

  const authorize =
    (permission: string) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      await authenticate(request, reply);
      if (!request.principal || !principalCan(request.principal, permission)) {
        throw forbidden(`missing permission: ${permission}`);
      }
    };

  return { authenticate, authorize };
}
