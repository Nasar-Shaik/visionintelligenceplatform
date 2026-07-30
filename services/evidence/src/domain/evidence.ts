/**
 * Domain: the Evidence aggregate — pure construction + the ONLY sanctioned mutations. Immutability is
 * structural: `newEvidence` sets the write-once fields (`_id`, `source`, `capturedAt`, `interval`,
 * `media`) and the mutators (`applyMetadataUpdate`, `applyRetention`, `markStatus`) touch **only** the
 * sidecar overlay (`metadata`/`ai`), lifecycle (`status`), and `retention` — never the original media,
 * source, id, or capture time. Original Media → Overlay → Presentation (Architect rec 2).
 */
import type {
  Evidence,
  EvidenceAiMetadata,
  EvidenceIntegrity,
  EvidenceMedia,
  EvidenceMetadata,
  EvidenceRetention,
  EvidenceStatus,
  RegisterEvidenceInput,
  SetRetentionInput,
  UpdateEvidenceMetadataInput,
} from '@vip/contracts';
import { EvidenceMetadata as EvidenceMetadataSchema } from '@vip/contracts';
import { evidenceId } from './integrity.js';

/** The persisted evidence document (`_id` = the stable evidence id). */
export interface EvidenceDoc {
  _id: string;
  tenantId: string;
  kind: Evidence['kind'];
  source: Evidence['source'];
  capturedAt: string;
  interval?: Evidence['interval'];
  media: EvidenceMedia;
  metadata: EvidenceMetadata;
  ai?: EvidenceAiMetadata;
  status: EvidenceStatus;
  retention: EvidenceRetention;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewEvidenceArgs {
  tenantId: string;
  createdBy: string;
  input: RegisterEvidenceInput;
  /** Resolved integrity (precomputed by the caller, or computed from stored bytes). */
  integrity: EvidenceIntegrity;
  now: Date;
  /** Default retention window (days) when the input omits `retainDays`. 0 = indefinite. */
  defaultRetentionDays: number;
}

/** ISO string `days` after `from` (UTC), or null for an indefinite (0) window. */
export function retainUntilFrom(fromISO: string, days: number): string | null {
  if (days <= 0) return null;
  return new Date(Date.parse(fromISO) + days * 86_400_000).toISOString();
}

/** Build a new, immutable evidence document from a registration. */
export function newEvidence(args: NewEvidenceArgs): EvidenceDoc {
  const { tenantId, createdBy, input, integrity, now } = args;
  const id = evidenceId(tenantId, input.storageKey);
  const nowISO = now.toISOString();
  const media: EvidenceMedia = {
    storageKey: input.storageKey,
    contentType: input.contentType,
    ...(input.codec ? { codec: input.codec } : {}),
    integrity,
    tier: 'active',
  };
  // Overlay defaults + any caller-provided metadata; version always starts at 1.
  const metadata = EvidenceMetadataSchema.parse({ ...(input.metadata ?? {}), metadataVersion: 1 });
  const retainDays = input.retainDays ?? args.defaultRetentionDays;
  const doc: EvidenceDoc = {
    _id: id,
    tenantId,
    kind: input.kind,
    source: input.source,
    capturedAt: input.capturedAt,
    ...(input.interval ? { interval: input.interval } : {}),
    media,
    metadata,
    ...(input.ai ? { ai: input.ai } : {}),
    // `available` once the bytes are confirmed (non-empty hash); else `pending`.
    status: integrity.hash ? 'available' : 'pending',
    retention: {
      retainUntil: retainUntilFrom(input.capturedAt, retainDays),
      legalHold: false,
    },
    createdBy,
    createdAt: nowISO,
    updatedAt: nowISO,
  };
  return doc;
}

/** Map the persisted doc to the public `Evidence` contract shape. */
export function toEvidence(doc: EvidenceDoc): Evidence {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

/**
 * Version-safe metadata update — bumps `metadataVersion`, patches only overlay fields (+ optional AI
 * sidecar), and NEVER touches media/source/id. Returns the new metadata/ai (caller persists them).
 */
export function applyMetadataUpdate(
  doc: EvidenceDoc,
  patch: UpdateEvidenceMetadataInput,
): { metadata: EvidenceMetadata; ai?: EvidenceAiMetadata } {
  const metadata: EvidenceMetadata = {
    ...doc.metadata,
    metadataVersion: doc.metadata.metadataVersion + 1,
    ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    ...(patch.zones !== undefined ? { zones: patch.zones } : {}),
    ...(patch.attributes !== undefined ? { attributes: patch.attributes } : {}),
  };
  return patch.ai !== undefined ? { metadata, ai: patch.ai } : { metadata };
}

/** Compute the next retention state from a set-retention input (audited by the caller). */
export function nextRetention(doc: EvidenceDoc, input: SetRetentionInput): EvidenceRetention {
  const retainUntil =
    input.retainDays !== undefined
      ? retainUntilFrom(doc.capturedAt, input.retainDays)
      : doc.retention.retainUntil;
  const legalHold = input.legalHold !== undefined ? input.legalHold : doc.retention.legalHold;
  return { retainUntil, legalHold };
}

/** Is this item eligible for purge at `now` (past retention AND not on legal hold)? */
export function isPurgeEligible(doc: EvidenceDoc, now: Date): boolean {
  if (doc.retention.legalHold) return false;
  if (doc.retention.retainUntil === null) return false;
  return Date.parse(doc.retention.retainUntil) <= now.getTime();
}
