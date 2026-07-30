/**
 * Domain: the append-only, **hash-chained** chain-of-custody. Each entry's `hash` covers a canonical
 * serialization of its content plus the previous entry's `hash`, so any tampering (reordering,
 * edit, deletion) breaks the chain and is detectable (`verifyChain`). Pure — no I/O. The genesis
 * entry (`seq: 0`, action `created`) has `prevHash: null`. Reason-for-access is captured on reads.
 */
import { createHash } from 'node:crypto';
import type { EvidenceCustodyAction, EvidenceCustodyEntry } from '@vip/contracts';

/** The persisted custody document (`_id` = the entry's uuid). */
export interface CustodyDoc extends Omit<EvidenceCustodyEntry, 'id'> {
  _id: string;
}

/** Canonical content hashed into the chain (stable key order → reproducible digest). */
function canonical(e: {
  prevHash: string | null;
  tenantId: string;
  evidenceId: string;
  seq: number;
  action: EvidenceCustodyAction;
  actor: string;
  at: string;
  details: Record<string, unknown>;
}): string {
  return JSON.stringify([
    e.prevHash,
    e.tenantId,
    e.evidenceId,
    e.seq,
    e.action,
    e.actor,
    e.at,
    e.details,
  ]);
}

export function custodyHash(e: Parameters<typeof canonical>[0]): string {
  return createHash('sha256').update(canonical(e)).digest('hex');
}

export interface NewCustodyArgs {
  id: string;
  tenantId: string;
  evidenceId: string;
  seq: number;
  action: EvidenceCustodyAction;
  actor: string;
  reason?: string | undefined;
  at: Date;
  details?: Record<string, unknown>;
  prevHash: string | null;
}

/** Build the next custody entry, linking it to `prevHash` and sealing it with its own `hash`. */
export function newCustodyEntry(args: NewCustodyArgs): CustodyDoc {
  const at = args.at.toISOString();
  const details = args.details ?? {};
  const hash = custodyHash({
    prevHash: args.prevHash,
    tenantId: args.tenantId,
    evidenceId: args.evidenceId,
    seq: args.seq,
    action: args.action,
    actor: args.actor,
    at,
    details,
  });
  return {
    _id: args.id,
    tenantId: args.tenantId,
    evidenceId: args.evidenceId,
    seq: args.seq,
    action: args.action,
    actor: args.actor,
    ...(args.reason !== undefined ? { reason: args.reason } : {}),
    at,
    details,
    prevHash: args.prevHash,
    hash,
  };
}

/** Map a persisted custody doc to the public contract shape. */
export function toCustodyEntry(doc: CustodyDoc): EvidenceCustodyEntry {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

/**
 * Verify a full custody chain (entries in seq order): each entry's `hash` must recompute, and each
 * `prevHash` must equal the previous entry's `hash` (genesis `prevHash` is null). Tamper-evident.
 */
export function verifyChain(entries: CustodyDoc[]): boolean {
  let prev: string | null = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.seq !== i) return false;
    if (e.prevHash !== prev) return false;
    const expected = custodyHash({
      prevHash: e.prevHash,
      tenantId: e.tenantId,
      evidenceId: e.evidenceId,
      seq: e.seq,
      action: e.action,
      actor: e.actor,
      at: e.at,
      details: e.details,
    });
    if (e.hash !== expected) return false;
    prev = e.hash;
  }
  return true;
}
