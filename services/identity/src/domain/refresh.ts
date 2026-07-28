/**
 * Domain: refresh-token records. Refresh tokens are opaque and looked up by their SHA-256 hash
 * (`_id`), so this is a **control-plane** collection (by-secret lookup, not a tenant-scoped query)
 * — each record still carries `tenantId` for context minting. Rotation forms a *family*: a new
 * token inherits the family id, the old one is marked used. Replaying a used token = reuse →
 * revoke the whole family (docs/architecture/phase1/AUTHENTICATION.md).
 */

/** Persisted refresh token. `_id` is the SHA-256 hash of the opaque token (unique). */
export interface RefreshTokenDoc {
  _id: string;
  tenantId: string;
  principalId: string;
  familyId: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

export function newRefreshRecord(
  tokenHash: string,
  tenantId: string,
  principalId: string,
  familyId: string,
  at: Date,
  expiresAt: Date,
): RefreshTokenDoc {
  return {
    _id: tokenHash,
    tenantId,
    principalId,
    familyId,
    createdAt: at.toISOString(),
    expiresAt: expiresAt.toISOString(),
    usedAt: null,
    revokedAt: null,
  };
}

/** A record is usable only if it is unused, not revoked, and not expired. */
export function isUsable(doc: RefreshTokenDoc, now: Date): boolean {
  return doc.usedAt === null && doc.revokedAt === null && new Date(doc.expiresAt) > now;
}
