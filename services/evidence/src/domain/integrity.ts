/**
 * Domain: content integrity + stable identity. Pure, no I/O. The evidence **id is derived from the
 * storage key** so re-registering the same object is idempotent and ids are stable forever (rec:
 * "Evidence IDs should remain stable"). The integrity hash is a SHA-256 over the stored bytes — the
 * tamper-evidence anchor of the chain-of-custody.
 */
import { createHash } from 'node:crypto';

/** Stable evidence id: `evd_` + sha1(tenantId | storageKey) truncated. Deterministic + idempotent. */
export function evidenceId(tenantId: string, storageKey: string): string {
  const h = createHash('sha1').update(`${tenantId}|${storageKey}`).digest('hex').slice(0, 24);
  return `evd_${h}`;
}

/** Hex SHA-256 of a byte payload (the media integrity hash). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
