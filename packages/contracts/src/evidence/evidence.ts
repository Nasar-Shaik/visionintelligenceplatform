/**
 * Evidence contracts (Phase 2, P2-2 G-4) — the public shapes of the **Evidence context**
 * (docs/architecture/22-BOUNDED-CONTEXTS §11, 23-SERVICE-OWNERSHIP §evidence, 12-EVIDENCE-MANAGEMENT).
 *
 * Evidence is the **defensible record** of what an AI-generated incident saw. The canonical descriptor
 * is the **Evidence Manifest** (G-4 Architect rec 1): a storage-implementation-independent record that
 * fully describes an evidence object. `Evidence` = the manifest + lifecycle/retention state.
 *
 * Design invariants encoded here:
 *   - **Immutable original (rec 2):** the stored media is never modified. The `media` block
 *     (`storageKey`/`contentType`/`integrity`/…) and `source`/`capturedAt` are write-once; overlays
 *     (`metadata`) and AI enrichment (`ai`) are **sidecar** — Original Media → Overlay → Presentation.
 *   - **Engine-agnostic (rec 6):** Evidence never names an AI engine. `source.producer` is an opaque
 *     capability id; `ai` is a structured but engine-neutral extension point stored verbatim.
 *   - **Traceable (rec 5):** `source` links every item back through Event → Rule → Incident.
 *   - **Storage-abstracted (rec 3):** bytes live behind a `StorageProvider` (@vip/storage `ObjectStore`);
 *     this contract only names an opaque tenant-relative `storageKey` + a provider-independent
 *     `StorageTier` (active→warm→cold→archive). No provider/bucket/filesystem path ever appears.
 *   - **Flexible relationships (rec 4):** many snapshots/clips/(future attachments/exports) per incident;
 *     `EvidenceKind` extends additively.
 *   - **Export-ready (rec 7):** the manifest + custody log + query compose a future export package with
 *     no structural change.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId, Uuid } from '../common/primitives.js';
import { EventPriority } from '../events/priority.js';

// ---------------------------------------------------------------------------
// Kinds, lifecycle & storage tiers
// ---------------------------------------------------------------------------

/** What an evidence item is. Extend additively (future: `export`, `attachment`, `timeline`). */
export const EvidenceKind = z.enum(['snapshot', 'clip']);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

/**
 * Evidence availability lifecycle (never reused for another meaning):
 *   pending   — record created; media not yet stored/confirmed.
 *   available — media stored + integrity recorded; retrievable via a signed URL.
 *   expired   — past its retention window; no longer served, record retained.
 *   purged    — media deleted by a verified retention sweep; the record remains as a tombstone.
 *   failed    — capture/store failed; kept for audit.
 */
export const EvidenceStatus = z.enum(['pending', 'available', 'expired', 'purged', 'failed']);
export type EvidenceStatus = z.infer<typeof EvidenceStatus>;

/**
 * Provider-independent storage tier (G-4 Architect rec 3). Distinct from availability `status`: it
 * describes WHERE the bytes live so a future lifecycle can move them without touching the record's
 * meaning. active → warm → cold → archive (→ then `status` expired → purged). A `StorageProvider`
 * implements the actual tier move; the tier here is the intent/label.
 */
export const StorageTier = z.enum(['active', 'warm', 'cold', 'archive']);
export type StorageTier = z.infer<typeof StorageTier>;

// ---------------------------------------------------------------------------
// Value objects — source, media, overlay, AI, retention
// ---------------------------------------------------------------------------

/**
 * Why this evidence exists — the **traceability chain** (rec 5), all standardized platform references,
 * **engine-agnostic** (rec 6). Answers "EventEnvelope → Rule → Incident → Evidence".
 */
export const EvidenceSource = z.object({
  cameraId: z.string().min(1).optional(),
  /** End-to-end correlation id shared with the originating Event/Incident/Alert. */
  correlationId: z.string().min(1).optional(),
  /** `EventEnvelope.id` that led here. */
  eventId: z.string().min(1).optional(),
  /** The rule whose match raised the incident (Event → Rule → Incident). */
  ruleId: z.string().min(1).optional(),
  /** The Incident this evidence supports. */
  incidentId: z.string().min(1).optional(),
  /** The media recording this snapshot/clip was derived from (Media context). */
  recordingId: z.string().min(1).optional(),
  /** Opaque producing capability id (never an AI engine/runtime name). */
  producer: z.string().min(1).optional(),
});
export type EvidenceSource = z.infer<typeof EvidenceSource>;

/** Content integrity for tamper-evidence (chain-of-custody). Write-once. */
export const EvidenceIntegrity = z.object({
  algorithm: z.literal('sha256'),
  /** Hex digest of the stored object's bytes. Empty only while `status: pending`. */
  hash: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});
export type EvidenceIntegrity = z.infer<typeof EvidenceIntegrity>;

/**
 * The **immutable media descriptor** — where the original bytes live and how to interpret them.
 * `storageKey` is an opaque tenant-relative key that resolves identically across any provider
 * (local/MinIO/S3/Azure/GCS), so the manifest stays storage-implementation-independent (rec 1/3).
 */
export const EvidenceMedia = z.object({
  /** Opaque tenant-relative object key (provider-agnostic). Never a filesystem/bucket path. */
  storageKey: z.string().min(1),
  /** MIME type (e.g. `image/jpeg`, `video/mp4`). */
  contentType: z.string().min(1),
  /** Optional codec (e.g. `h264`) for video clips. */
  codec: z.string().min(1).optional(),
  integrity: EvidenceIntegrity,
  tier: StorageTier.default('active'),
});
export type EvidenceMedia = z.infer<typeof EvidenceMedia>;

/** The time range a clip covers (absent for a point-in-time snapshot). */
export const EvidenceInterval = z
  .object({
    startedAt: IsoDateTime,
    endedAt: IsoDateTime,
    durationSeconds: z.number().nonnegative(),
  })
  .refine((i) => Date.parse(i.endedAt) >= Date.parse(i.startedAt), {
    message: 'endedAt must be at or after startedAt',
    path: ['endedAt'],
  });
export type EvidenceInterval = z.infer<typeof EvidenceInterval>;

/**
 * Version-safe **overlay** metadata (sidecar) — updates NEVER mutate the original media (rec 2). Each
 * accepted update bumps `metadataVersion`, so history is reconstructable and the media stays untouched.
 */
export const EvidenceMetadata = z.object({
  metadataVersion: z.number().int().min(1).default(1),
  severity: EventPriority.optional(),
  label: z.string().min(1).max(200).optional(),
  note: z.string().max(2000).optional(),
  tags: z.array(z.string().min(1).max(64)).default([]),
  /** Zone ids the moment relates to (spatial context). */
  zones: z.array(z.string().min(1)).default([]),
  /** Free-form, additive operator attributes — never identities in the clear. */
  attributes: z.record(z.string(), z.unknown()).default({}),
});
export type EvidenceMetadata = z.infer<typeof EvidenceMetadata>;

/**
 * **AI metadata extension point** (rec 6) — a structured but **engine-agnostic** sidecar for future
 * AI enrichment. The Evidence service stores it verbatim and never depends on any of these fields, so
 * a new model/engine adds richer metadata without a contract change. All optional.
 */
export const EvidenceAiMetadata = z.object({
  modelName: z.string().min(1).optional(),
  modelVersion: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  /** Detected object classes/labels (no vendor shape assumed). */
  detectedObjects: z.array(z.string().min(1)).optional(),
  /** Tracked object ids for cross-frame correlation. */
  trackIds: z.array(z.string().min(1)).optional(),
  inferenceAt: IsoDateTime.optional(),
  /** Higher-order behaviour tags (loitering/fight/…) — advisory, engine-neutral. */
  behavior: z.array(z.string().min(1)).optional(),
  /** Additive catch-all so future AI fields never require a breaking change. */
  attributes: z.record(z.string(), z.unknown()).default({}),
});
export type EvidenceAiMetadata = z.infer<typeof EvidenceAiMetadata>;

/** Retention state. `legalHold` overrides deletion until released. */
export const EvidenceRetention = z.object({
  /** When the item becomes eligible for purge. `null` = retained indefinitely. */
  retainUntil: IsoDateTime.nullable().default(null),
  legalHold: z.boolean().default(false),
});
export type EvidenceRetention = z.infer<typeof EvidenceRetention>;

// ---------------------------------------------------------------------------
// Evidence Manifest (canonical descriptor) & the Evidence record
// ---------------------------------------------------------------------------

/**
 * **Evidence Manifest** (rec 1) — the canonical, storage-implementation-independent metadata record
 * for one evidence object. Self-contained enough to be the JSON manifest in a future export package
 * (rec 7). `id` is **stable** (derived from the storage key), so re-registering the same object is
 * idempotent. Separates the immutable original (`media`) from sidecar overlays (`metadata`, `ai`).
 */
export const EvidenceManifest = z.object({
  id: z.string().min(1),
  tenantId: TenantId,
  kind: EvidenceKind,
  /** Why this exists (rec 5) — Event → Rule → Incident references. */
  source: EvidenceSource,
  /** When the captured moment occurred (snapshot instant, or a clip's start). */
  capturedAt: IsoDateTime,
  /** Present for `kind: clip`. */
  interval: EvidenceInterval.optional(),
  /** The immutable original-media descriptor. */
  media: EvidenceMedia,
  /** Version-safe operator overlay (sidecar). */
  metadata: EvidenceMetadata,
  /** Engine-agnostic AI enrichment (sidecar), if any. */
  ai: EvidenceAiMetadata.optional(),
});
export type EvidenceManifest = z.infer<typeof EvidenceManifest>;

/**
 * A persisted evidence item = its manifest + availability/retention lifecycle. The queryable,
 * traceable, immutable index over the stored media.
 */
export const Evidence = EvidenceManifest.extend({
  status: EvidenceStatus,
  retention: EvidenceRetention,
  createdBy: z.string().min(1),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Evidence = z.infer<typeof Evidence>;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Register an evidence item for media that already lives in object storage (produced by the media /
 * inference tiers, or uploaded out-of-band). The service verifies the object exists, records
 * integrity, and opens the custody log. Passing a precomputed `integrity` avoids reading large media
 * back into memory (recommended for clips); if omitted, the service computes the hash from the stored
 * bytes (fine for snapshots).
 */
export const RegisterEvidenceInput = z.object({
  kind: EvidenceKind,
  /** Tenant-relative key of an object already present in the StorageProvider. */
  storageKey: z.string().min(1),
  contentType: z.string().min(1),
  codec: z.string().min(1).optional(),
  capturedAt: IsoDateTime,
  source: EvidenceSource.default({}),
  interval: EvidenceInterval.optional(),
  metadata: EvidenceMetadata.partial().optional(),
  ai: EvidenceAiMetadata.optional(),
  /** Precomputed integrity (recommended for large media); computed from bytes when omitted. */
  integrity: EvidenceIntegrity.optional(),
  /** Days to retain from `capturedAt`; omitted/0 = indefinite. `legalHold` can override later. */
  retainDays: z.number().int().min(0).optional(),
});
export type RegisterEvidenceInput = z.infer<typeof RegisterEvidenceInput>;

/**
 * Version-safe metadata update. Applies an additive patch to the overlay and **bumps
 * `metadataVersion`** — it never touches the media, `storageKey`, `integrity`, `id`, or `source`.
 */
export const UpdateEvidenceMetadataInput = z.object({
  severity: EventPriority.optional(),
  label: z.string().min(1).max(200).optional(),
  note: z.string().max(2000).optional(),
  /** Replaces the tag set when present. */
  tags: z.array(z.string().min(1).max(64)).optional(),
  zones: z.array(z.string().min(1)).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  /** Optional engine-agnostic AI enrichment to attach/replace (sidecar). */
  ai: EvidenceAiMetadata.optional(),
  /** Audit reason for the change (chain-of-custody). */
  reason: z.string().min(1).max(500).optional(),
});
export type UpdateEvidenceMetadataInput = z.infer<typeof UpdateEvidenceMetadataInput>;

/** Set/replace retention or place/release a legal hold (audited). */
export const SetRetentionInput = z.object({
  retainDays: z.number().int().min(0).optional(),
  legalHold: z.boolean().optional(),
  tier: StorageTier.optional(),
  reason: z.string().min(1).max(500).optional(),
});
export type SetRetentionInput = z.infer<typeof SetRetentionInput>;

// ---------------------------------------------------------------------------
// Query / retrieval
// ---------------------------------------------------------------------------

/** Tenant-scoped evidence query (newest-first) with an opaque forward cursor (keyset pagination). */
export const EvidenceQuery = z.object({
  kind: EvidenceKind.optional(),
  status: EvidenceStatus.optional(),
  cameraId: z.string().min(1).optional(),
  incidentId: z.string().min(1).optional(),
  eventId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
  /** Inclusive lower bound on `capturedAt`. */
  from: IsoDateTime.optional(),
  /** Exclusive upper bound on `capturedAt`. */
  to: IsoDateTime.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});
export type EvidenceQuery = z.infer<typeof EvidenceQuery>;

/** One page of evidence items. */
export const EvidencePage = z.object({
  items: z.array(Evidence),
  nextCursor: z.string().min(1).optional(),
});
export type EvidencePage = z.infer<typeof EvidencePage>;

/**
 * A short-lived, signed download/playback target for one evidence object. Access is **signed-URL
 * only** — never public. The URL expires; re-request it. Issuing one is an audited access.
 */
export const EvidenceDownloadTarget = z.object({
  evidenceId: z.string().min(1),
  key: z.string().min(1),
  url: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});
export type EvidenceDownloadTarget = z.infer<typeof EvidenceDownloadTarget>;

// ---------------------------------------------------------------------------
// Chain of custody (append-only, hash-chained)
// ---------------------------------------------------------------------------

/** A custody action recorded against an evidence item. */
export const EvidenceCustodyAction = z.enum([
  'created',
  'accessed',
  'metadata-updated',
  'retention-set',
  'legal-hold-placed',
  'legal-hold-released',
  'expired',
  'purged',
]);
export type EvidenceCustodyAction = z.infer<typeof EvidenceCustodyAction>;

/**
 * One append-only custody entry. Entries form a **hash chain** per evidence item (`hash` covers the
 * entry content + `prevHash`), so tampering is detectable. `reason` captures reason-for-access.
 */
export const EvidenceCustodyEntry = z.object({
  id: Uuid,
  tenantId: TenantId,
  evidenceId: z.string().min(1),
  /** Monotonic sequence within the item (0 = `created`). */
  seq: z.number().int().min(0),
  action: EvidenceCustodyAction,
  actor: z.string().min(1),
  reason: z.string().max(500).optional(),
  at: IsoDateTime,
  details: z.record(z.string(), z.unknown()).default({}),
  /** Hash of the previous entry (null for the genesis `created` entry). */
  prevHash: z.string().nullable(),
  /** `sha256(prevHash | tenantId | evidenceId | seq | action | actor | at | details)`. */
  hash: z.string().min(1),
});
export type EvidenceCustodyEntry = z.infer<typeof EvidenceCustodyEntry>;

/** One page of custody entries (oldest-first — a custody log reads chronologically). */
export const EvidenceCustodyPage = z.object({
  items: z.array(EvidenceCustodyEntry),
  nextCursor: z.string().min(1).optional(),
});
export type EvidenceCustodyPage = z.infer<typeof EvidenceCustodyPage>;
