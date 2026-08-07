/**
 * Application ports (hexagonal seams). The supervisor depends only on these interfaces; adapters
 * (HTTP camera client, ffmpeg decoder, S3 storage, perception sink) implement them, and tests
 * substitute fakes. This is what keeps the ingestion lifecycle fully unit-testable without ffmpeg,
 * a camera, or a network.
 */
import type {
  AnalysisSessionState,
  EventEnvelope,
  Incident,
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

/**
 * ⭐ **Where a frame came from, carried with the frame** (P-8 Phase 8, slice 3).
 *
 * A live camera *is* its own provenance: the camera id and the wall-clock capture time say
 * everything there is to know, and both are already on the frame. A frame decoded out of a stored
 * recording is not — the same camera id can be re-analysed from five different files, twice from the
 * same file, and resumed halfway through. Without this, "which run produced this detection, from
 * which file, at which point in it" is unanswerable, and every later slice (timeline, incident
 * review, evidence extraction, the export report) needs the answer.
 *
 * ⚠️ **`mediaOffsetSeconds` is derived; `ptsSeconds` is measured.** The derivation is
 * `(seq − 1) / frameRate`, which is exact for constant-frame-rate footage and wrong for anything
 * else. Keeping both is what lets the decoder *notice* when a file disagrees with the arithmetic
 * rather than shifting every incident in it — see the `timestamps-diverged` finding.
 */
export interface FrameProvenance {
  /** ⚠️ What kind of thing produced it, so a consumer never has to infer it from absent fields. */
  sourceKind: 'live-stream' | 'stored-media';
  /** The media it was decoded from: the object key for stored media, the stream url's host for live. */
  sourceId: string;
  /** The analysis and the session this frame belongs to. Absent for live. */
  analysisId?: string;
  sessionId?: string;
  /** ⭐ The chunk that produced it — the unit a resume restarts from, so a gap is attributable. */
  chunkId?: string;
  chunkIndex?: number;
  /** Position in the footage, seconds. **Derived** from `seq` and `frameRate`. */
  mediaOffsetSeconds: number;
  /**
   * The container's own presentation timestamp, seconds.
   *
   * ⛔ `null` when the decoder could not read one — never `0`, which is a real and very different
   * answer (ADR-0039). A null here means the divergence check could not run, not that it passed.
   */
  ptsSeconds: number | null;
  /** The rate the source was asked to emit at. Needed to reproduce `mediaOffsetSeconds`. */
  frameRate: number;
  /** What decoded it, with its version — a decoder upgrade can change a result on its own. */
  decoder: string;
}

/** A decoded video frame handed to perception. In P1-4 `data` may be a JPEG; P1-6 consumes it. */
export interface Frame {
  seq: number;
  at: Date;
  data?: Uint8Array;
  /**
   * Where this frame came from (P-8 Phase 8, slice 3).
   *
   * ⚠️ Optional, and the live decoder deliberately does not set it. A camera frame's provenance is
   * already complete in `cameraId` + `at`; inventing a record that adds nothing would be one more
   * thing to keep true on the hot path of every camera in the estate.
   */
  provenance?: FrameProvenance;
}

/**
 * What happened to one frame that was **delivered rather than pushed** (P-8 Phase 8, slice 3).
 *
 * ⚠️ Returned rather than counted, because the offline caller has to act on it: a frame the runtime
 * refused is a hole in an investigation and has to become a finding on the session, where the live
 * path can legitimately settle for a metric that says how many were lost.
 */
export interface FrameDelivery {
  outcome: 'delivered' | 'failed' | 'skipped-unassigned' | 'skipped-held' | 'no-image';
  /** Detections the runtime returned. `0` is a real answer here — the frame was analysed. */
  detections: number;
  /** Present when `outcome` is not `delivered` — the operator-facing reason. */
  reason?: string;
  /** ⭐ What the runtime said it ran. The session's provenance is captured from this, not assumed. */
  runtimeVersion?: string;
  modelId?: string;
  executionProvider?: string;
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

/**
 * Where extracted frames go for perception. P1-4 ships a null sink; P1-6 wires the pipeline.
 *
 * ### ⭐ One delivery path, two admission policies (P-8 Phase 8, slice 3)
 *
 * `push` and `deliver` reach the **same** runtime through the same request, the same assignment
 * gate, the same zone capture and the same publisher. They differ only in what happens at the door
 * when the runtime cannot keep up, and the two answers are opposites for good reasons:
 *
 * - **`push` drops.** A live frame is perishable. Blocking would apply back-pressure to the process
 *   writing MP4 segments, so a slow runtime would become missing evidence. The oldest frame goes and
 *   the freshest is kept, because only the freshest can still matter.
 * - **`deliver` waits.** ⛔ There is no such thing as a stale frame in a *recording*. Every frame is
 *   evidence a customer uploaded and expects to have been looked at, nothing downstream of it is
 *   waiting in real time, and a dropped one is a hole in an investigation that no counter can fill.
 *
 * ⚠️ **`deliver` is also what makes offline results reproducible**, which is the less obvious half.
 * The live path keeps four requests in flight, so responses arrive out of order — and the runtime's
 * tracker *skips* a frame older than the last one it saw, exactly as this service's event publisher
 * drops a stale result. Under concurrency, which frames get skipped depends on scheduling, so two
 * runs of one file would disagree. Awaiting each frame in turn makes the offline path strictly
 * ordered, and strict ordering is what turns "the same file twice" into the same answer twice.
 */
export interface FrameSink {
  push(tenantId: string, cameraId: string, frame: Frame): void;
  /**
   * Deliver one frame and wait for its outcome. Absent ⇒ the sink offers no lossless path.
   *
   * ⚠️ Optional on the port because `NullFrameSink` is a legitimate deployment, and a caller that
   * needs losslessness must fail loudly on a sink that cannot provide it rather than fall back to
   * `push` and silently start dropping the customer's evidence.
   */
  deliver?(
    tenantId: string,
    cameraId: string,
    frame: Frame,
    signal: AbortSignal,
  ): Promise<FrameDelivery>;
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
 * Reads back the events one analysis session produced (P-8 Phase 8, slice 4).
 *
 * ⭐ **The timeline is derived from the events, never stored.** A stored timeline can disagree with
 * the events it claims to summarise, and the disagreement surfaces months later in front of a
 * customer. The events are the record; the timeline is a view.
 *
 * ⚠️ Absent in a deployment with no events service configured — media records and analyses without
 * one, so the timeline reports that it is unavailable rather than returning an empty one. "No events
 * service" and "no events" are different answers.
 */
export interface AnalysisEventCaller {
  /**
   * ⛔ **The requesting user's `authorization` header, forwarded — never a service key.**
   *
   * A service key would work and would quietly widen what a timeline can show beyond what the person
   * asking for it is entitled to open. `services/workflow` made exactly this decision for the
   * incident timeline; the same rule applies here, for the same reason.
   */
  authorization: string;
}

export interface AnalysisEventSource {
  /**
   * Every event of one run, oldest first.
   *
   * ⚠️ Returns `truncated` rather than silently capping. "The first two thousand events" and "the
   * events" are different claims about an investigation, and only one of them is true.
   */
  forSession(
    scope: TenantScope,
    sessionId: string,
    limit: number,
    caller: AnalysisEventCaller,
  ): Promise<{ events: EventEnvelope[]; truncated: boolean }>;
}

/**
 * Reads back the incidents one analysis run raised (P-8 Phase 8, slice 5).
 *
 * ⚠️ Separate from `AnalysisEventSource` because it is a **different service** and can be absent
 * independently. A deployment with events but no workflow answers `incidentsAvailable: false` rather
 * than an empty lane — "we cannot look" and "we looked and found none" are opposite answers.
 */
export interface AnalysisIncidentSource {
  forSession(
    scope: TenantScope,
    sessionId: string,
    limit: number,
    caller: AnalysisEventCaller,
  ): Promise<{ incidents: Incident[]; truncated: boolean }>;
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
