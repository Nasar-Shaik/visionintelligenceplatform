/** Edge authentication: extract + verify the Bearer access token, returning its claims (or 401). */
import type { FastifyRequest } from 'fastify';
import { AuthError, verifyAccessToken, type AccessClaims, type JwtOptions } from '@vip/auth';

export async function authenticateRequest(
  request: FastifyRequest,
  opts: JwtOptions,
): Promise<AccessClaims> {
  const header = request.headers['authorization'];
  const token =
    typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : null;
  if (!token) throw new AuthError('missing bearer token');
  return verifyAccessToken(token, opts);
}
