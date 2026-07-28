/**
 * Opaque refresh tokens. The token is high-entropy random and given to the client; only its
 * SHA-256 hash is persisted, so a leaked datastore never yields usable tokens. Rotation and
 * reuse-detection (revoke the whole family when a used token is replayed) are owned by the
 * identity service, which stores the hashes — see docs/architecture/phase1/AUTHENTICATION.md.
 */
import { createHash, randomBytes } from 'node:crypto';

/** Mint a new opaque refresh token (256 bits, URL-safe). */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Hash a refresh token for storage/lookup (never store the raw token). */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
