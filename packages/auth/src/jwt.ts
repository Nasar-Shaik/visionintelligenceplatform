/**
 * Access-token signing/verification with **jose** (pure-JS, no native build). Access tokens are
 * short-lived HS256 JWTs whose claims mint the downstream `TenantContext`. HS256 (shared secret
 * from `.env`, ADR-0018) is the P1-2 choice; an RS256/JWKS split (identity signs, gateway verifies
 * with a public key) is a documented future upgrade — swap the key material, not the call sites.
 */
import { SignJWT, jwtVerify } from 'jose';
import { AuthError } from './errors.js';
import { parseDurationSeconds } from './duration.js';

export interface AccessClaims {
  principalId: string;
  tenantId: string;
  email: string;
  roles: string[];
}

export interface JwtOptions {
  secret: string;
  /** Access-token lifetime, e.g. "15m" (default) or seconds. */
  accessTtl?: string;
  issuer?: string;
  audience?: string;
}

const DEFAULTS = { issuer: 'vip', audience: 'vip', accessTtl: '15m' };

function keyOf(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Sign an access token. Returns the compact JWT and its lifetime in seconds. */
export async function signAccessToken(
  claims: AccessClaims,
  opts: JwtOptions,
): Promise<{ token: string; expiresIn: number }> {
  const issuer = opts.issuer ?? DEFAULTS.issuer;
  const audience = opts.audience ?? DEFAULTS.audience;
  const expiresIn = parseDurationSeconds(opts.accessTtl ?? DEFAULTS.accessTtl);
  const nowSec = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({
    tid: claims.tenantId,
    email: claims.email,
    roles: claims.roles,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.principalId)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + expiresIn)
    .setIssuer(issuer)
    .setAudience(audience)
    .sign(keyOf(opts.secret));

  return { token, expiresIn };
}

/** Verify an access token and return its claims. Throws `AuthError` on any failure (expired, tampered, wrong iss/aud). */
export async function verifyAccessToken(token: string, opts: JwtOptions): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, keyOf(opts.secret), {
      issuer: opts.issuer ?? DEFAULTS.issuer,
      audience: opts.audience ?? DEFAULTS.audience,
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.tid !== 'string') {
      throw new AuthError('token missing required claims');
    }
    return {
      principalId: payload.sub,
      tenantId: payload.tid,
      email: typeof payload.email === 'string' ? payload.email : '',
      roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
    };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError('invalid or expired token');
  }
}
