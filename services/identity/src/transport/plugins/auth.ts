/**
 * Transport: access-token authentication + permission authorization. `createAuth` builds two
 * preHandlers from the JWT settings: `authenticate` (verify the `Authorization: Bearer <jwt>`
 * header via @vip/auth and attach the principal) and `authorize(permission)` (authenticate, then
 * gate via the @vip/permissions PDP, deny-by-default). They are injected into the routes that need
 * them — explicit DI over Fastify function-decorators. See phase1/AUTHENTICATION.md.
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
  issuer?: string;
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
  // Plain 2-arg async handlers — assignable to `preHandlerHookHandler`, and directly callable.
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
