/**
 * Application ports (hexagonal seams). The supervisor depends only on these interfaces; adapters
 * (HTTP camera client, ffmpeg decoder, S3 storage, perception sink) implement them, and tests
 * substitute fakes. This is what keeps the ingestion lifecycle fully unit-testable without ffmpeg,
 * a camera, or a network.
 */
import type { ClipQuery, RecordingQuery, RecordingSegment, StreamConnection } from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import type { RecordingDoc } from '../domain/recording.js';
import type { ClipDoc } from '../domain/clip.js';

/** Resolves a camera's connection descriptor (with decrypted credentials) from the Camera context. */
export interface CameraSource {
  resolve(tenantId: string, cameraId: string): Promise<StreamConnection>;
}

/** A decoded video frame handed to perception. In P1-4 `data` may be a JPEG; P1-6 consumes it. */
export interface Frame {
  seq: number;
  at: Date;
  data?: Uint8Array;
}

/** A finalized recording segment emitted by the decoder, ready to persist. */
export interface DecodedSegment {
  body: Uint8Array;
  startedAt: Date;
  durationSeconds: number;
  contentType: string;
}

/** Lifecycle callbacks the decoder invokes for one open stream. */
export interface DecoderCallbacks {
  /** The input opened and media is flowing. */
  onConnected(): void;
  /** A frame was extracted (at the configured rate). */
  onFrame(frame: Frame): void;
  /** A recording segment finalized and is ready to store. */
  onSegment(segment: DecodedSegment): void | Promise<void>;
  /** The stream failed / was lost (network drop, decode error, unexpected exit). */
  onError(error: Error): void;
  /** The stream ended cleanly (only after an explicit stop). */
  onClose(): void;
}

export interface DecodeOptions {
  /** Target frame-extraction rate (frames/sec) for perception. */
  frameRate: number;
  /** Recording segment length in seconds. */
  segmentSeconds: number;
}

/** An active decode session; `stop()` tears it down (no further callbacks after it resolves). */
export interface DecoderSession {
  stop(): Promise<void>;
}

/** Opens a decode session for a resolved connection, delivering events via `cb`. */
export interface Decoder {
  open(conn: StreamConnection, opts: DecodeOptions, cb: DecoderCallbacks): DecoderSession;
}

/** Where extracted frames go for perception. P1-4 ships a null sink; P1-6 wires the pipeline. */
export interface FrameSink {
  push(tenantId: string, cameraId: string, frame: Frame): void;
}

/**
 * Where finalized recording segments are indexed for later retrieval (P2-2 G-2). The supervisor
 * calls this after a successful storage write so the segment becomes queryable/playable. The default
 * is a no-op sink (P1-4 behaviour); the composition root wires the Mongo-backed catalog. Indexing
 * failures degrade (logged) and never block the live path — same posture as the storage write.
 */
export interface RecordingSink {
  record(segment: RecordingSegment): Promise<void>;
}

/** Default recording sink: indexes nothing (pre-G-2 behaviour / tests that don't assert indexing). */
export const nullRecordingSink: RecordingSink = {
  async record() {
    /* intentionally empty */
  },
};

/**
 * Persistence port for the media catalog (P2-2 G-2): recording + clip metadata, tenant-scoped. A
 * Mongo adapter backs production; an in-memory adapter backs unit tests. All reads/writes require a
 * `TenantScope` so isolation is structural (Law 5). Recording upserts are idempotent on the derived
 * recording id, so re-indexing the same segment is a no-op.
 */
export interface MediaCatalogStore {
  /** Idempotent upsert of a recording (on `_id`). */
  putRecording(scope: TenantScope, doc: RecordingDoc): Promise<void>;
  /** Newest-first, keyset-paginated recording listing. */
  listRecordings(
    scope: TenantScope,
    q: RecordingQuery,
  ): Promise<{ items: RecordingDoc[]; nextCursor?: string }>;
  getRecording(scope: TenantScope, id: string): Promise<RecordingDoc | null>;
  /** Recordings whose time range overlaps [from, to), oldest-first (for clip playback/coverage). */
  recordingsCovering(
    scope: TenantScope,
    cameraId: string,
    from: string,
    to: string,
  ): Promise<RecordingDoc[]>;

  putClip(scope: TenantScope, doc: ClipDoc): Promise<void>;
  listClips(scope: TenantScope, q: ClipQuery): Promise<{ items: ClipDoc[]; nextCursor?: string }>;
  getClip(scope: TenantScope, id: string): Promise<ClipDoc | null>;
  /** Delete a clip within scope; returns whether a document was removed. */
  deleteClip(scope: TenantScope, id: string): Promise<boolean>;
}

/** Deferred timer, injectable so reconnect scheduling is deterministic under test. */
export interface Timers {
  set(fn: () => void, ms: number): NodeJS.Timeout;
  clear(handle: NodeJS.Timeout): void;
}

export const systemTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle),
};
