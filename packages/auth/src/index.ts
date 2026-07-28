/**
 * @vip/auth — authentication primitives shared by the identity service and the gateway.
 * Build-free crypto: scrypt password hashing (node:crypto) + jose HS256 access tokens +
 * opaque, hashed refresh tokens. Authorization lives in @vip/permissions; token/refresh
 * *state* and reuse-detection live in the identity service. See phase1/AUTHENTICATION.md.
 */
export { AuthError } from './errors.js';
export { hashPassword, verifyPassword } from './password.js';
export { signAccessToken, verifyAccessToken, type AccessClaims, type JwtOptions } from './jwt.js';
export { generateRefreshToken, hashRefreshToken } from './refresh.js';
export { parseDurationSeconds } from './duration.js';

/** Package version — bump per Constitution §7. */
export const AUTH_VERSION = '0.1.0';
