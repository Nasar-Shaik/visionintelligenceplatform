/**
 * Application ports (hexagonal seams). The supervisor depends only on these interfaces; adapters
 * (HTTP camera client, ffmpeg decoder, S3 storage, perception sink) implement them, and tests
 * substitute fakes. This is what keeps the ingestion lifecycle fully unit-testable without ffmpeg,
 * a camera, or a network.
 */
import type {
  AnalysisSessionState,
  ClipQuery,
  RecordingQuery,
  RecordingSegment,
  StreamConnection,
  VideoAnalysisQuery,
} from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import type { RecordingDoc } from '../domain/recording.js';
import type { ClipDoc } from '../domain/clip.js';
import type { AnalysisDoc, AnalysisSessionDoc } from '../domain/analysis.js';

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

/**
 * Persistence port for offline video investigation (P-8 Phase 8). Tenant-scoped like everything
 * else here; a Mongo adapter backs production and an in-memory one backs unit tests.
 *
 * ⚠️ **Sessions are appended and updated, never replaced.** A terminal session is immutable — the
 * service enforces it, and the store offers no operation that would let a caller rewrite one.
 */
export interface AnalysisStore {
  putAnalysis(scope: TenantScope, doc: AnalysisDoc): Promise<void>;
  getAnalysis(scope: TenantScope, id: string): Promise<AnalysisDoc | null>;
  listAnalyses(
    scope: TenantScope,
    q: VideoAnalysisQuery,
  ): Promise<{ items: AnalysisDoc[]; nextCursor?: string }>;
  deleteAnalysis(scope: TenantScope, id: string): Promise<boolean>;

  putSession(scope: TenantScope, doc: AnalysisSessionDoc): Promise<void>;
  getSession(scope: TenantScope, id: string): Promise<AnalysisSessionDoc | null>;
  /** Every session of one analysis, newest first. */
  listSessions(scope: TenantScope, analysisId: string): Promise<AnalysisSessionDoc[]>;
  /** Sessions in a non-terminal state, across analyses — what a worker claims from. */
  listActiveSessions(scope: TenantScope): Promise<AnalysisSessionDoc[]>;
  /**
   * ⭐ **Conditional write.** Move a session into `next` only if it is still in `expectedState` and
   * still held by `expectedWorkerId` (or by nobody, when that is `null`). Returns whether the write
   * landed.
   *
   * ⚠️ This is the whole of multi-worker safety, and it exists because slice 1 proved that a
   * read-then-write is not exclusion: two workers can both read a `queued` session and both decide
   * they own it. Only the store can settle it, so only the store is asked to.
   */
  compareAndSetSession(
    scope: TenantScope,
    id: string,
    expected: { state: AnalysisSessionState; workerId: string | null },
    next: AnalysisSessionDoc,
  ): Promise<boolean>;
}

/**
 * Confirms a camera is real and belongs to this tenant.
 *
 * ⚠️ **Existence, not identity.** It deliberately does not offer a display name: nothing internal
 * carries one, and a port that returned the id as a "name" would put an id in a field that means a
 * name — which is how `cam_a1b2c3` ends up printed on a customer's report.
 */
export interface CameraDirectory {
  exists(tenantId: string, cameraId: string): Promise<boolean>;
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
