/**
 * Media / ingestion contracts (Phase 1, P1-4). The `media` service connects a camera's stream,
 * decodes frames for perception, and records segments to tenant-scoped object storage. It depends
 * on the Camera context (credentials) and on @vip/storage. Grounds:
 * docs/architecture/phase1/INGESTION_PIPELINE.md, STORAGE_ARCHITECTURE.md,
 * docs/architecture/22-BOUNDED-CONTEXTS.md §4 (Media context).
 */
import { z } from 'zod';
import { IsoDateTime, TenantId } from '../common/primitives.js';
import { CameraProtocol } from '../camera/camera.js';

/**
 * Lifecycle of a per-camera ingestion worker:
 *   idle → connecting → connected → (lost → connecting …) → stopped.
 */
export const StreamState = z.enum(['idle', 'connecting', 'connected', 'lost', 'stopped']);
export type StreamState = z.infer<typeof StreamState>;

/** Observable status of one camera's stream worker (returned by the status API). */
export const StreamStatus = z.object({
  cameraId: z.string().min(1),
  tenantId: TenantId,
  state: StreamState,
  /** When the current state was entered. */
  since: IsoDateTime,
  /** Whether segments are currently being recorded. */
  recording: z.boolean(),
  /** Consecutive reconnect attempts since the last successful connect (reset on connect). */
  reconnectAttempts: z.number().int().min(0),
  /** Frames handed to the perception sink so far (monotonic within a worker's life). */
  framesReceived: z.number().int().min(0),
  lastSegmentAt: IsoDateTime.optional(),
  /** Last error observed (loss/decode), for diagnostics — never contains credentials. */
  lastError: z.string().max(500).optional(),
});
export type StreamStatus = z.infer<typeof StreamStatus>;

/** Metadata for one recorded media segment persisted under `{tenantId}/{cameraId}/recordings/…`. */
export const RecordingSegment = z.object({
  cameraId: z.string().min(1),
  tenantId: TenantId,
  /** Tenant-relative object key within @vip/storage (e.g. `cam_1/recordings/seg-….mp4`). */
  key: z.string().min(1),
  startedAt: IsoDateTime,
  durationSeconds: z.number().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string().min(1),
});
export type RecordingSegment = z.infer<typeof RecordingSegment>;

// ---------------------------------------------------------------------------
// P2-2 G-2 — Media catalog (recording + clip metadata) & playback
// ---------------------------------------------------------------------------

/**
 * A persisted, queryable recording (the segment metadata indexed for retrieval — P2-2 G-2). The
 * bytes live in object storage (`key`); this is the searchable record the console lists and plays
 * back. `id` is stable and derived from the object key, so re-indexing the same segment is
 * idempotent. `endedAt = startedAt + durationSeconds`.
 */
export const Recording = RecordingSegment.extend({
  id: z.string().min(1),
  endedAt: IsoDateTime,
  createdAt: IsoDateTime,
});
export type Recording = z.infer<typeof Recording>;

/** Tenant-scoped, bounded recording query (newest-first) with an opaque forward cursor (P2-2 G-2). */
export const RecordingQuery = z.object({
  cameraId: z.string().min(1).optional(),
  /** Inclusive lower bound on `startedAt`. */
  from: IsoDateTime.optional(),
  /** Exclusive upper bound on `startedAt`. */
  to: IsoDateTime.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});
export type RecordingQuery = z.infer<typeof RecordingQuery>;

/** One page of recordings. */
export const RecordingPage = z.object({
  items: z.array(Recording),
  nextCursor: z.string().min(1).optional(),
});
export type RecordingPage = z.infer<typeof RecordingPage>;

/**
 * A short-lived, signed playback target for one stored object (P2-2 G-2). Media access is
 * **signed-URL only** — never public (STORAGE_ARCHITECTURE §MinIO). The URL expires; re-request it.
 */
export const PlaybackTarget = z.object({
  key: z.string().min(1),
  url: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
  contentType: z.string().min(1).optional(),
});
export type PlaybackTarget = z.infer<typeof PlaybackTarget>;

/**
 * Clip export lifecycle (P2-2 G-2). A clip starts `pending` — it is a named bookmark over a time
 * range; materializing an actual cut file is deferred to a later media enhancement. `ready` means a
 * standalone clip object exists (`key`); `failed` records an export error. Until materialized, clip
 * playback resolves to the covered recording segments.
 */
export const ClipStatus = z.enum(['pending', 'ready', 'failed']);
export type ClipStatus = z.infer<typeof ClipStatus>;

/** Input to bookmark a clip over a camera's recorded time range (P2-2 G-2). */
export const CreateClipInput = z
  .object({
    cameraId: z.string().min(1),
    startedAt: IsoDateTime,
    endedAt: IsoDateTime,
    label: z.string().min(1).max(200).optional(),
    note: z.string().max(2000).optional(),
    /** Optional link to an incident this clip is evidence for (evidence trail, G-4). */
    incidentId: z.string().min(1).optional(),
  })
  .refine((c) => Date.parse(c.endedAt) > Date.parse(c.startedAt), {
    message: 'endedAt must be after startedAt',
    path: ['endedAt'],
  });
export type CreateClipInput = z.infer<typeof CreateClipInput>;

/**
 * A persisted clip (P2-2 G-2): a named, playable time range of a camera's footage, optionally linked
 * to an incident as evidence. `segmentKeys` are the recording object keys the range covers at
 * creation time; `key`/`sizeBytes` are populated only once a standalone clip is materialized.
 */
export const Clip = z.object({
  id: z.string().min(1),
  tenantId: TenantId,
  cameraId: z.string().min(1),
  label: z.string().min(1).max(200).optional(),
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  durationSeconds: z.number().nonnegative(),
  status: ClipStatus,
  note: z.string().max(2000).optional(),
  incidentId: z.string().min(1).optional(),
  /** Recording object keys covering the range at creation (for pre-materialization playback). */
  segmentKeys: z.array(z.string().min(1)).default([]),
  /** The materialized clip object key, once exported (`status: ready`). */
  key: z.string().min(1).nullable().default(null),
  sizeBytes: z.number().int().nonnegative().optional(),
  createdBy: z.string().min(1),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Clip = z.infer<typeof Clip>;

/** Tenant-scoped clip query (newest-first) with an opaque forward cursor (P2-2 G-2). */
export const ClipQuery = z.object({
  cameraId: z.string().min(1).optional(),
  incidentId: z.string().min(1).optional(),
  status: ClipStatus.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});
export type ClipQuery = z.infer<typeof ClipQuery>;

/** One page of clips. */
export const ClipPage = z.object({
  items: z.array(Clip),
  nextCursor: z.string().min(1).optional(),
});
export type ClipPage = z.infer<typeof ClipPage>;

/**
 * Playback for a clip (P2-2 G-2). When materialized (`clip.key`), `segments` is a single target for
 * the standalone object; otherwise it is the ordered signed targets for the recordings the clip
 * range covers (played back-to-back by the console).
 */
export const ClipPlayback = z.object({
  clip: Clip,
  segments: z.array(PlaybackTarget),
});
export type ClipPlayback = z.infer<typeof ClipPlayback>;

/**
 * Operational health of a stream, derived from its worker state (P2-2 G-2):
 *   connected → healthy · connecting/lost → degraded · stopped → down · (no worker/idle) → unknown.
 */
export const StreamHealthState = z.enum(['healthy', 'degraded', 'down', 'unknown']);
export type StreamHealthState = z.infer<typeof StreamHealthState>;

/** Health view for one camera's stream worker (P2-2 G-2). */
export const StreamHealthReport = z.object({
  cameraId: z.string().min(1),
  tenantId: TenantId,
  health: StreamHealthState,
  state: StreamState,
  since: IsoDateTime,
  recording: z.boolean(),
  reconnectAttempts: z.number().int().min(0),
  framesReceived: z.number().int().min(0),
  lastError: z.string().max(500).optional(),
});
export type StreamHealthReport = z.infer<typeof StreamHealthReport>;

/** Aggregate stream health across a tenant's workers (P2-2 G-2). */
export const StreamHealthSummary = z.object({
  tenantId: TenantId,
  total: z.number().int().min(0),
  healthy: z.number().int().min(0),
  degraded: z.number().int().min(0),
  down: z.number().int().min(0),
  streams: z.array(StreamHealthReport),
});
export type StreamHealthSummary = z.infer<typeof StreamHealthSummary>;

/**
 * Internal connection descriptor resolved from the Camera context (the ONE place credentials are
 * decrypted). It is a service-to-service DTO — NOT a public/gateway contract and deliberately not
 * emitted to JSON Schema, since it carries plaintext credentials transiently (used, never stored).
 */
export const StreamConnection = z.object({
  cameraId: z.string().min(1),
  protocol: CameraProtocol,
  streamUrl: z.string().min(1),
  username: z.string().optional(),
  password: z.string().optional(),
});
export type StreamConnection = z.infer<typeof StreamConnection>;
