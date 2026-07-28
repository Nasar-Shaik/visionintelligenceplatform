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
