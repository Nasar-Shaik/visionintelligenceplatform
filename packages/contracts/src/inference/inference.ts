/**
 * Inference platform contracts (Phase 2, P2-2 G-3) — the control-plane wire truth for the
 * **model-agnostic** inference runtime (`ai/inference`): a managed **model registry** (versions,
 * active selection, metadata, capabilities, enable/disable), **inference sessions** (the first-class
 * per-camera pipeline lifecycle), **runtime metrics**, and the **pipeline** stage definition. The Python runtime mirrors
 * these shapes (`ai/inference/contracts.py`); this TS package is the source of truth (JSON Schema is
 * generated from here). Grounds: docs/architecture/05-CAPABILITY-ARCHITECTURE.md,
 * 08-AI-ML-PLATFORM.md, docs/architecture/phase1/AI_PIPELINE.md; ADR-0002 (model-agnostic),
 * ADR-0012 (adapter layer).
 *
 * Invariant: the inference runtime produces **EventEnvelope** objects only — it NEVER creates
 * incidents (that is the rules/workflow contexts, P1-7/P1-8).
 */
import { z } from 'zod';
import { CapabilityId, IsoDateTime, SemVer, TenantId } from '../common/primitives.js';
import { CameraCapabilities } from '../camera/camera.js';

/**
 * The execution engine a model runs on. Deliberately open-ended and **not** YOLO-specific: the
 * runtime talks to every engine through one `ModelAdapter` seam (ADR-0012), so new engines plug in
 * without touching capability code. `python-custom` covers arbitrary in-process Python models.
 */
export const ModelEngine = z.enum([
  'yolo',
  'onnx',
  'tensorrt',
  'openvino',
  'torchscript',
  'python-custom',
]);
export type ModelEngine = z.infer<typeof ModelEngine>;

/** Serialized artifact format (informational; the engine adapter knows how to load it). */
export const ModelFormat = z.enum(['onnx', 'engine', 'openvino-ir', 'torchscript', 'pt', 'custom']);
export type ModelFormat = z.infer<typeof ModelFormat>;

/** Administrative state of a registered model — whether the runtime may select it. */
export const ModelStatus = z.enum(['enabled', 'disabled']);
export type ModelStatus = z.infer<typeof ModelStatus>;

/** Hardware the model expects/prefers. */
export const Accelerator = z.enum(['cpu', 'gpu', 'npu']);
export type Accelerator = z.infer<typeof Accelerator>;

/**
 * A single immutable version of a model artifact. Versions are append-only; activation points the
 * registry at one of them. `metrics` is an optional benchmark snapshot (map/latency) for governance.
 */
export const ModelVersion = z.object({
  version: SemVer,
  engine: ModelEngine,
  format: ModelFormat,
  /** Where the artifact lives (e.g. an MLflow model URI, an S3 key). Never plaintext credentials. */
  artifactUri: z.string().min(1).max(2048),
  /** Class label space the model emits (index → label). */
  classes: z.array(z.string().min(1)).default([]),
  /** Expected input tensor shape, e.g. [1, 3, 640, 640]. */
  inputShape: z.array(z.number().int().positive()).default([]),
  accelerator: Accelerator.default('cpu'),
  /** Content hash for integrity / reproducibility. */
  checksum: z.string().min(1).max(200).optional(),
  /** Optional benchmark metadata (e.g. `{ mAP: 0.53, latencyMs: 8.2 }`). */
  metrics: z.record(z.string(), z.number()).default({}),
  createdAt: IsoDateTime,
});
export type ModelVersion = z.infer<typeof ModelVersion>;

/**
 * Structured, queryable capabilities of a model (P2-2 G-3) — what it can do, so Rules and future UI
 * can *reason about* a model instead of parsing its name. Beyond the capability ids it serves, it
 * declares the concrete event types it can emit, their categories, expected performance, and its
 * confidence-threshold envelope.
 */
export const ModelCapabilityProfile = z.object({
  /** Canonical event types the model can emit (from the event catalog), e.g. `perception.person.detected`. */
  supportedEventTypes: z.array(z.string().min(1)).default([]),
  /** Coarse categories those events fall under (perception/security/safety/analytics/system). */
  supportedCategories: z.array(z.string().min(1)).default([]),
  /** Required input tensor size [width, height] (px). */
  inputSize: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  /** Expected sustained throughput on the reference accelerator. */
  expectedFps: z.number().positive().optional(),
  /** Accelerators the model can run on. */
  acceleration: z.array(Accelerator).default([]),
  /** Allowed confidence-threshold range the operator may tune within, e.g. { min: 0.25, max: 0.9 }. */
  confidenceThreshold: z
    .object({ min: z.number().min(0).max(1), max: z.number().min(0).max(1) })
    .optional(),
});
export type ModelCapabilityProfile = z.infer<typeof ModelCapabilityProfile>;

/** Free-form operator/provenance metadata for a model (never affects execution). */
export const ModelMetadata = z.object({
  vendor: z.string().max(200).optional(),
  license: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().min(1).max(50)).max(50).default([]),
});
export type ModelMetadata = z.infer<typeof ModelMetadata>;

/**
 * A registered, tenant-scoped model. `task` is a coarse capability family (e.g. `object-detection`,
 * `fire-smoke`, `pose`); `capabilities` are the `@vip/contracts` capability ids this model can serve
 * (e.g. `perception.person-detection`). `activeVersion` selects which version the runtime uses; a
 * model with no active version (or `disabled`) is not selectable.
 */
export const ModelRegistration = z.object({
  id: z.string().min(1),
  tenantId: TenantId,
  name: z.string().min(1).max(200),
  task: z.string().min(1).max(100),
  engine: ModelEngine,
  status: ModelStatus,
  /** The active version string, or null when none is active yet. */
  activeVersion: SemVer.nullable().default(null),
  versions: z.array(ModelVersion).default([]),
  capabilities: z.array(CapabilityId).default([]),
  /** Structured, queryable capabilities (event types/categories/perf/thresholds). */
  capabilityProfile: ModelCapabilityProfile,
  metadata: ModelMetadata,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ModelRegistration = z.infer<typeof ModelRegistration>;

/** Input to register a new model (server assigns id/status/timestamps; versions added separately). */
export const RegisterModelInput = z.object({
  name: z.string().min(1).max(200),
  task: z.string().min(1).max(100),
  engine: ModelEngine,
  capabilities: z.array(CapabilityId).default([]),
  capabilityProfile: ModelCapabilityProfile.optional(),
  metadata: ModelMetadata.optional(),
});
export type RegisterModelInput = z.infer<typeof RegisterModelInput>;

/** Input to append a version to a model. */
export const AddModelVersionInput = z.object({
  version: SemVer,
  engine: ModelEngine.optional(),
  format: ModelFormat,
  artifactUri: z.string().min(1).max(2048),
  classes: z.array(z.string().min(1)).default([]),
  inputShape: z.array(z.number().int().positive()).default([]),
  accelerator: Accelerator.optional(),
  checksum: z.string().min(1).max(200).optional(),
  metrics: z.record(z.string(), z.number()).optional(),
});
export type AddModelVersionInput = z.infer<typeof AddModelVersionInput>;

// ---------------------------------------------------------------------------
// Runtime metrics
// ---------------------------------------------------------------------------

/**
 * A runtime metrics snapshot (P2-2 G-3). Reported per session/capability and aggregated by the
 * runtime. All fields are deterministically computable from counters + a windowed latency sample, so
 * the whole snapshot is unit-testable without hardware. GPU is optional — reported only where an
 * accelerator is present.
 */
export const RuntimeMetrics = z.object({
  /** Frames processed per second (windowed). */
  fps: z.number().nonnegative(),
  framesProcessed: z.number().int().nonnegative(),
  /** Frames deliberately skipped (e.g. frame-rate downsampling for perception). */
  framesSkipped: z.number().int().nonnegative(),
  /** Frames lost to backpressure/inference failure. */
  droppedFrames: z.number().int().nonnegative(),
  /** Average inference latency (ms). */
  avgLatencyMs: z.number().nonnegative(),
  /** Inference latency percentiles (ms). */
  latencyP50Ms: z.number().nonnegative(),
  latencyP95Ms: z.number().nonnegative(),
  /** Pending frames waiting to be inferred. */
  queueDepth: z.number().int().nonnegative(),
  /**
   * Detection-confidence distribution as fixed [0,1] buckets of width 0.1 (10 counts). Lets the
   * dashboard show a histogram + lets rules reason about model behaviour without raw detections.
   */
  confidenceDistribution: z
    .array(z.number().int().nonnegative())
    .length(10)
    .default(new Array(10).fill(0)),
  /** One-time model load duration (ms). */
  modelLoadMs: z.number().nonnegative().optional(),
  cpuPercent: z.number().nonnegative().optional(),
  /** GPU utilisation percent, where a GPU is present. */
  gpuPercent: z.number().nonnegative().optional(),
  memoryMb: z.number().nonnegative().optional(),
  uptimeSeconds: z.number().nonnegative(),
  /**
   * AI-2 tracking observability (additive, all optional — reported once a tracking pipeline runs;
   * absent for pure detection). Feeds capacity planning + production monitoring. Business-neutral.
   */
  detectionFps: z.number().nonnegative().optional(),
  frameDropPercent: z.number().min(0).max(100).optional(),
  activeTracks: z.number().int().nonnegative().optional(),
  confirmedTracks: z.number().int().nonnegative().optional(),
  tentativeTracks: z.number().int().nonnegative().optional(),
  lostTracks: z.number().int().nonnegative().optional(),
  /** Tracks that reached the terminal `removed` state over the session. */
  removedTracks: z.number().int().nonnegative().optional(),
  /** Average track age in frames (created → now). */
  averageTrackAgeFrames: z.number().nonnegative().optional(),
  /** Average total lifetime in frames of removed tracks (created → removed). */
  averageTrackLifetime: z.number().nonnegative().optional(),
  /** Average trajectory length (history points) across active tracks. */
  averageTrackLength: z.number().nonnegative().optional(),
  /** Average per-frame centroid displacement (normalized units) across active tracks. */
  averageTrackVelocity: z.number().nonnegative().optional(),
  /** Total zone entry/exit crossings observed in the window. */
  zoneCrossings: z.number().int().nonnegative().optional(),
  /** Counting events emitted per second (windowed). */
  countingRate: z.number().nonnegative().optional(),
  /**
   * AI-3 behavior observability (additive, all optional — reported once behavior analyzers run;
   * absent for pure detection/tracking). Feeds performance tuning + production monitoring.
   * Business-neutral: counts/durations/latencies of analysis, never a business signal.
   */
  activeBehaviors: z.number().int().nonnegative().optional(),
  /** Behavior instances that reached a terminal state (`ended`/`expired`) over the session. */
  completedBehaviors: z.number().int().nonnegative().optional(),
  /** Average lifetime (seconds) of completed behavior instances. */
  averageBehaviorDuration: z.number().nonnegative().optional(),
  /** Average confidence across active behavior instances. */
  averageBehaviorConfidence: z.number().min(0).max(1).optional(),
  /** Average wall-time (ms) a single analyzer invocation takes. */
  analyzerExecutionTime: z.number().nonnegative().optional(),
  /** Total analyzer invocations over the session (analyzers × frames evaluated). */
  analyzerInvocationCount: z.number().int().nonnegative().optional(),
  /** End-to-end behavior-stage latency (ms) per frame. */
  behaviorLatency: z.number().nonnegative().optional(),
  /** Behavior instances started per minute (windowed). */
  behaviorsPerMinute: z.number().nonnegative().optional(),
  /**
   * AI-4 composite + profile observability (additive, all optional — reported once composite analysis /
   * profiles run). Business-neutral counts/durations of analysis, never a business signal.
   */
  analyzerQueueDepth: z.number().int().nonnegative().optional(),
  behaviorWindowCount: z.number().int().nonnegative().optional(),
  averageWindowDuration: z.number().nonnegative().optional(),
  activeTemporalWindows: z.number().int().nonnegative().optional(),
  compositeBehaviorCount: z.number().int().nonnegative().optional(),
  behaviorCorrelationCount: z.number().int().nonnegative().optional(),
  /** Composite-analyzer evaluations over the session (analyzers × frames evaluated). */
  compositeEvaluations: z.number().int().nonnegative().optional(),
  /** Composite evaluations that matched (produced a composite) vs. did not (Architect AI-4 refinement 8). */
  compositeMatches: z.number().int().nonnegative().optional(),
  compositeMisses: z.number().int().nonnegative().optional(),
  /** Average composite evaluation latency (ms). */
  averageCompositeLatency: z.number().nonnegative().optional(),
  /** Average confidence across produced composite behaviors. */
  averageCompositeConfidence: z.number().min(0).max(1).optional(),
  /** Average wall-time (ms) a composite evaluation takes. */
  compositeExecutionTime: z.number().nonnegative().optional(),
  profileLoads: z.number().int().nonnegative().optional(),
  profileValidationFailures: z.number().int().nonnegative().optional(),
  activeProfiles: z.number().int().nonnegative().optional(),
  /** Total behavior relationships (parent/follows/related) recorded over the session. */
  behaviorRelationshipCount: z.number().int().nonnegative().optional(),
  /**
   * AI-5a production/benchmark observability (additive, all optional — operational, not perception).
   * More operational fields (reconnectCount/restartCount/streamAvailability/averageRecoveryTime) arrive
   * with their producing slices (AI-5b/AI-5d) to avoid fields with no producer.
   */
  sessionCount: z.number().int().nonnegative().optional(),
  /** End-to-end latency (ms) from frame capture to emitted EventEnvelope. */
  eventLatencyMs: z.number().nonnegative().optional(),
  /** Events emitted per second (windowed). */
  eventThroughput: z.number().nonnegative().optional(),
  /** Benchmark runs executed against this runtime (governance bookkeeping). */
  benchmarkRunCount: z.number().int().nonnegative().optional(),
  /**
   * AI-5b live-ingestion observability (additive, all optional — operational, not perception; the
   * fields AI-5a reserved for this slice, now with a producer). Reported once a session runs against
   * a live `StreamSource`; absent for offline/batch analysis. Transport-neutral (never RTSP-specific).
   */
  reconnectCount: z.number().int().nonnegative().optional(),
  /** Session restarts driven by the lifecycle (failed/stopped → restarting → running). */
  restartCount: z.number().int().nonnegative().optional(),
  /** Percentage of session wall-time the source spent `connected`. */
  streamAvailability: z.number().min(0).max(100).optional(),
  /** Mean wall-time (ms) from connection loss back to `connected`. */
  averageRecoveryTime: z.number().nonnegative().optional(),
  /** Sessions currently in `running` across the supervisor (multi-camera capacity). */
  activeSessions: z.number().int().nonnegative().optional(),
  /**
   * Backpressure tuning signals (AI-5b refinement 3) — `queueDepth` alone hides both peaks and
   * sustained pressure. These four are what an operator sizes a production deployment with.
   */
  queueHighWatermark: z.number().int().nonnegative().optional(),
  /** Queue depth as a percentage of capacity. */
  queueUtilization: z.number().min(0).max(100).optional(),
  averageQueueDepth: z.number().nonnegative().optional(),
  /** Mean wall-time (ms) a frame waits between enqueue and the start of analysis. */
  processingDelayMs: z.number().nonnegative().optional(),
});
export type RuntimeMetrics = z.infer<typeof RuntimeMetrics>;

// ---------------------------------------------------------------------------
// Metric groups (AI-5c, Architect AI-5b rec 2) — operational vs AI
// ---------------------------------------------------------------------------

/**
 * The two logical groups every runtime metric belongs to, kept separate so production monitoring
 * stays clean (Architect AI-5b rec 2):
 *
 *   - `operational` — is the system HEALTHY? availability, reconnects, queue utilization, latency,
 *     CPU/memory/GPU. Owned by ops; alerts page a human.
 *   - `ai`          — is the system SEEING correctly? inference FPS, detections, tracks, behaviors,
 *     confidence, generated events. Owned by the AI team; changes here mean model/pipeline work.
 *
 * They are deliberately **views over the existing `RuntimeMetrics`**, not a new parallel metric
 * pipeline: one producer, two audiences. `METRIC_GROUPS` is the authoritative partition, so a
 * dashboard never has to guess which bucket a field belongs to.
 */
export const MetricGroup = z.enum(['operational', 'ai']);
export type MetricGroup = z.infer<typeof MetricGroup>;

/** Authoritative partition of `RuntimeMetrics` field names into the two groups. */
export const METRIC_GROUPS: Record<MetricGroup, readonly string[]> = {
  operational: [
    'fps',
    'framesProcessed',
    'framesSkipped',
    'droppedFrames',
    'frameDropPercent',
    'avgLatencyMs',
    'latencyP50Ms',
    'latencyP95Ms',
    'queueDepth',
    'queueHighWatermark',
    'queueUtilization',
    'averageQueueDepth',
    'processingDelayMs',
    'uptimeSeconds',
    'memoryMb',
    'cpuPercent',
    'gpuPercent',
    'modelLoadMs',
    'sessionCount',
    'activeSessions',
    'reconnectCount',
    'restartCount',
    'streamAvailability',
    'averageRecoveryTime',
    'eventLatencyMs',
    'benchmarkRunCount',
  ],
  ai: [
    'detectionFps',
    'detectionsTotal',
    'avgConfidence',
    'confidenceDistribution',
    'activeTracks',
    'confirmedTracks',
    'tentativeTracks',
    'lostTracks',
    'removedTracks',
    'averageTrackAgeFrames',
    'averageTrackLifetime',
    'averageTrackLength',
    'averageTrackVelocity',
    'zoneCrossings',
    'countingRate',
    'activeBehaviors',
    'compositeBehaviorCount',
    'behaviorCorrelationCount',
    'behaviorRelationshipCount',
    'compositeEvaluations',
    'compositeMatches',
    'compositeMisses',
    'averageCompositeLatency',
    'averageCompositeConfidence',
    'compositeExecutionTime',
    'activeTemporalWindows',
    'averageWindowDuration',
    'profileLoads',
    'profileValidationFailures',
    'activeProfiles',
    'eventThroughput',
  ],
} as const;

// ---------------------------------------------------------------------------
// Live ingestion — the Video Source stage (AI-5b)
// ---------------------------------------------------------------------------

/**
 * The transport a live video source speaks. Deliberately **open-ended and protocol-neutral**
 * (Architect AI-5b refinement 4): every source plugs in behind ONE `StreamSource` seam, so RTSP is
 * simply the first implementation — HTTP/USB/file/WebRTC/ONVIF/cloud follow without touching runtime
 * code. `simulated` is the deterministic in-memory source that lets CI prove connection lifecycle,
 * reconnect, and availability with no network.
 */
export const StreamSourceType = z.enum([
  'rtsp',
  'http',
  'file',
  'usb',
  'webrtc',
  'onvif',
  'cloud',
  'simulated',
]);
export type StreamSourceType = z.infer<typeof StreamSourceType>;

/**
 * How to reach a live video source. **Never carries plaintext credentials** — secrets are referenced
 * by `credentialRef` and resolved out-of-band (ADR-0018), and any URI is redacted before it reaches a
 * log, a diagnostic, or an error message. `options` stays transport-agnostic: implementation-specific
 * knobs live there so the contract itself makes no RTSP-shaped assumption.
 */
export const StreamSourceConfig = z.object({
  type: StreamSourceType,
  /** Locator for the source (URL, device path, file path). Redacted wherever it is surfaced. */
  uri: z.string().min(1).max(2048),
  /** Opaque reference to credentials held by the platform's secret store — never the secret itself. */
  credentialRef: z.string().min(1).max(200).optional(),
  /** Perception frame rate requested from this source (the sampler's target). */
  targetFps: z.number().positive().max(120).optional(),
  /** Transport-specific settings (e.g. transport=tcp, deviceIndex, loop). Opaque to the runtime. */
  options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  /**
   * Declared device capabilities (AI-5c, Architect AI-5b rec 1). When present the runtime **reads**
   * these instead of **probing** the camera: it clamps its sampling FPS into `fpsRange` and selects
   * the analysis stream profile from `streamProfiles`. Probing costs a connection + decode on every
   * session start; declaring costs nothing on the Nth restart. Optional — a source with no declared
   * capabilities simply uses the requested settings unchanged.
   */
  capabilities: CameraCapabilities.optional(),
  /** Which named stream profile to analyze. Defaults to the `preferredForAnalysis` one, else the source itself. */
  streamProfile: z.string().min(1).max(100).optional(),
});
export type StreamSourceConfig = z.infer<typeof StreamSourceConfig>;

/**
 * Connection lifecycle of a live source, owned by the runtime's connection supervisor:
 *   idle → connecting → connected → lost → reconnecting → connected … → stopped
 * `failed` is terminal (reconnect budget exhausted). Distinct from `InferenceSessionState`: a source
 * can be `reconnecting` while its session is still `running` — ingestion health is not session state.
 */
export const StreamConnectionState = z.enum([
  'idle',
  'connecting',
  'connected',
  'lost',
  'reconnecting',
  'stopped',
  'failed',
]);
export type StreamConnectionState = z.infer<typeof StreamConnectionState>;

/**
 * Operational failure categories, kept **separate and mutually exclusive** so production diagnostics
 * can tell "the camera went away" from "the model broke" (Architect AI-5b refinement 4). Each maps to
 * a distinct diagnostic code and a distinct recovery path:
 *
 * | category        | tier       | diagnostic code | recovery path                              |
 * | --------------- | ---------- | --------------- | ------------------------------------------ |
 * | `connection`    | ingestion  | `AI-CONN`       | reconnect with backoff (automatic)         |
 * | `model`         | engine     | `AI-MODEL`      | rebind/roll back the model version         |
 * | `inference`     | per-frame  | `AI-INFER`      | skip the frame; session continues          |
 * | `pipeline`      | post-infer | `AI-PIPE`       | skip the frame; session continues          |
 * | `configuration` | control    | `AI-CONFIG`     | operator fix — never retried, fail fast    |
 *
 * A `configuration` failure is deliberately NOT recoverable at runtime: retrying a bad source config
 * or an unsupported transport just burns the reconnect budget and hides the real problem.
 */
export const RuntimeFailureCategory = z.enum([
  'connection',
  'model',
  'inference',
  'pipeline',
  'configuration',
]);
export type RuntimeFailureCategory = z.infer<typeof RuntimeFailureCategory>;

/** Stable diagnostic code per failure category (log/alert correlation key). */
export const RUNTIME_FAILURE_CODES: Record<RuntimeFailureCategory, string> = {
  connection: 'AI-CONN',
  model: 'AI-MODEL',
  inference: 'AI-INFER',
  pipeline: 'AI-PIPE',
  configuration: 'AI-CONFIG',
};

/** Whether a category is recoverable by the runtime itself (vs. requiring an operator). */
export const RUNTIME_FAILURE_RECOVERY: Record<
  RuntimeFailureCategory,
  'reconnect' | 'rebind' | 'skip-frame' | 'operator'
> = {
  connection: 'reconnect',
  model: 'rebind',
  inference: 'skip-frame',
  pipeline: 'skip-frame',
  configuration: 'operator',
};

/** A counted, categorized runtime failure (no stack traces, no credentials). */
export const RuntimeFailureSummary = z.object({
  category: RuntimeFailureCategory,
  /** Stable diagnostic code (see `RUNTIME_FAILURE_CODES`). */
  code: z.string().min(1).max(40),
  count: z.number().int().nonnegative().default(0),
  /** Last message observed for this category (redacted, bounded). */
  lastError: z.string().max(1000).optional(),
  lastAt: IsoDateTime.optional(),
});
export type RuntimeFailureSummary = z.infer<typeof RuntimeFailureSummary>;

/**
 * The **logical** identity of a running session (Architect AI-5b refinement 1). Every metric, log,
 * diagnostic and failure references THIS — never a thread id, process id, or host handle, so the
 * identity survives restarts, thread churn, and relocation to another host.
 */
export const SessionIdentity = z.object({
  tenantId: TenantId,
  cameraId: z.string().min(1),
  sessionId: z.string().min(1),
  /** Propagated onto every operational record so ingestion issues correlate with the event spine. */
  correlationId: z.string().min(1).max(200).optional(),
});
export type SessionIdentity = z.infer<typeof SessionIdentity>;

/**
 * Live-ingestion diagnostics — the **source tier** only (Architect AI-5b refinement 2: `StreamSource`
 * owns connection, reconnect and frame acquisition). Queue/drop accounting belongs to the pipeline
 * tier and lives in `StreamBackpressureStats`, so the two never overlap. Transport-neutral: identical
 * shape whether the source is RTSP, a file, or simulated.
 */
export const StreamIngestionStats = z.object({
  state: StreamConnectionState,
  sourceType: StreamSourceType,
  /** The source locator, **redacted** (credentials stripped) — safe to log and to show an operator. */
  source: z.string().max(2048),
  connectedAt: IsoDateTime.optional(),
  lastFrameAt: IsoDateTime.optional(),
  /** Frames acquired from the source (before sampling or queueing). */
  framesRead: z.number().int().nonnegative().default(0),
  reconnectCount: z.number().int().nonnegative().default(0),
  /** Percentage of observed wall-time spent `connected`. */
  availabilityPercent: z.number().min(0).max(100).default(0),
  /** Mean wall-time (ms) from loss back to `connected`. */
  averageRecoveryMs: z.number().nonnegative().default(0),
  uptimeSeconds: z.number().nonnegative().default(0),
  /** Categorized failure tallies (all five categories land here for one operational view). */
  failures: z.array(RuntimeFailureSummary).default([]),
  lastError: z.string().max(1000).optional(),
});
export type StreamIngestionStats = z.infer<typeof StreamIngestionStats>;

/**
 * Backpressure diagnostics — the **pipeline tier** (Architect AI-5b refinements 2 + 3: `StreamPipeline`
 * owns the queue, frame lifecycle and drop policy). These are the numbers an operator tunes a
 * production deployment with: how full the queue ran, how long frames waited, and how much of the
 * loss was deliberate policy vs. genuine degradation.
 */
export const StreamBackpressureStats = z.object({
  /** Frames deliberately down-sampled — an execution policy, NOT loss. */
  framesSkipped: z.number().int().nonnegative().default(0),
  /** Frames genuinely lost to bounded-queue overflow — real degradation. */
  framesDropped: z.number().int().nonnegative().default(0),
  /** Frames that completed analysis. */
  framesProcessed: z.number().int().nonnegative().default(0),
  queueCapacity: z.number().int().positive(),
  queueDepth: z.number().int().nonnegative().default(0),
  /** Deepest the queue ever got — the headroom signal for sizing. */
  queueHighWatermark: z.number().int().nonnegative().default(0),
  /** Depth as a percentage of capacity at the last observation. */
  queueUtilization: z.number().min(0).max(100).default(0),
  /** Mean queue depth across observations (sustained pressure, not just peaks). */
  averageQueueDepth: z.number().nonnegative().default(0),
  /** Mean wall-time (ms) a frame waited between enqueue and analysis start. */
  processingDelayMs: z.number().nonnegative().default(0),
  /** Deepest observed enqueue→analysis wait (ms). */
  maxProcessingDelayMs: z.number().nonnegative().default(0),
});
export type StreamBackpressureStats = z.infer<typeof StreamBackpressureStats>;

/** Aggregate view of the multi-camera supervisor (capacity + fleet health). */
export const SessionSupervisorStats = z.object({
  activeSessions: z.number().int().nonnegative().default(0),
  maxSessions: z.number().int().positive(),
  /** Sessions by lifecycle state, e.g. `{ running: 4, paused: 1 }`. */
  byState: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** Sessions whose source is not currently `connected`. */
  degradedSessions: z.number().int().nonnegative().default(0),
  totalReconnects: z.number().int().nonnegative().default(0),
  /** Mean source availability across running sessions. */
  averageAvailabilityPercent: z.number().min(0).max(100).default(0),
});
export type SessionSupervisorStats = z.infer<typeof SessionSupervisorStats>;

// ---------------------------------------------------------------------------
// Inference sessions — the first-class operational unit (one running pipeline)
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of an inference session (P2-2 G-3):
 *   created → starting → running → paused → stopped
 *   running/paused/starting → failed (fatal); failed/stopped → restarting → running.
 * The session is the OPERATIONAL UNIT the console monitors.
 */
export const InferenceSessionState = z.enum([
  'created',
  'starting',
  'running',
  'paused',
  'stopped',
  'failed',
  'restarting',
]);
export type InferenceSessionState = z.infer<typeof InferenceSessionState>;

/** The control action requested against a session (drives the state machine). */
export const InferenceSessionAction = z.enum(['start', 'stop', 'pause', 'resume', 'restart']);
export type InferenceSessionAction = z.infer<typeof InferenceSessionAction>;

/** One transition in a session's history (audit). */
export const InferenceSessionTransition = z.object({
  from: InferenceSessionState.nullable(),
  to: InferenceSessionState,
  action: InferenceSessionAction.optional(),
  at: IsoDateTime,
  reason: z.string().max(500).optional(),
});
export type InferenceSessionTransition = z.infer<typeof InferenceSessionTransition>;

/** A session's operational health — derived from state + heartbeat freshness. */
export const SessionHealth = z.enum(['healthy', 'degraded', 'down', 'unknown']);
export type SessionHealth = z.infer<typeof SessionHealth>;

/**
 * An **Inference Session** — one running inference pipeline bound to a camera + capability + model
 * version + engine. This is the first-class operational unit for monitoring the runtime: it carries a
 * live state, a heartbeat, an immutable transition history, and its latest metrics + health. Sessions
 * are tenant-scoped.
 */
export const InferenceSession = z.object({
  sessionId: z.string().min(1),
  tenantId: TenantId,
  cameraId: z.string().min(1),
  capabilityId: CapabilityId,
  /** The model registration this session runs (optional until bound). */
  modelId: z.string().min(1).optional(),
  /** The active model version at session start (provenance). */
  modelVersion: SemVer.optional(),
  engine: ModelEngine.optional(),
  state: InferenceSessionState,
  health: SessionHealth,
  /** When the session first entered `running`. */
  startedAt: IsoDateTime.optional(),
  /** Last liveness heartbeat from the running pipeline. */
  lastHeartbeat: IsoDateTime.optional(),
  metrics: RuntimeMetrics.optional(),
  history: z.array(InferenceSessionTransition).default([]),
  lastError: z.string().max(1000).optional(),
  /**
   * Live-ingestion diagnostics (AI-5b, additive) — present only when the session is bound to a live
   * `StreamSource`. Absent for offline/batch analysis, so an existing session shape is unchanged.
   */
  ingestion: StreamIngestionStats.optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type InferenceSession = z.infer<typeof InferenceSession>;

/**
 * Input to start a session. `source` is **optional and additive** (AI-5b): omit it for the existing
 * control-plane-only session; supply it to bind the session to a live video source and have the
 * runtime pump frames through the pipeline.
 */
export const StartInferenceSessionInput = z.object({
  cameraId: z.string().min(1),
  capabilityId: CapabilityId,
  modelId: z.string().min(1).optional(),
  source: StreamSourceConfig.optional(),
});
export type StartInferenceSessionInput = z.infer<typeof StartInferenceSessionInput>;

/** Tenant-scoped session query. */
export const InferenceSessionQuery = z.object({
  cameraId: z.string().min(1).optional(),
  state: InferenceSessionState.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});
export type InferenceSessionQuery = z.infer<typeof InferenceSessionQuery>;

/**
 * The full operational picture of one live session (AI-5b): who it is (logical identity), its source
 * tier, its pipeline tier, and its lifecycle counters — the three ownership boundaries kept visibly
 * separate. This is what `GET /sessions/{id}/stream` returns.
 */
export const SessionDiagnostics = z.object({
  identity: SessionIdentity,
  state: InferenceSessionState,
  ingestion: StreamIngestionStats,
  backpressure: StreamBackpressureStats,
  /** Lifecycle restarts driven by the session state machine. */
  restartCount: z.number().int().nonnegative().default(0),
  startedAt: IsoDateTime.optional(),
  lastHeartbeat: IsoDateTime.optional(),
});
export type SessionDiagnostics = z.infer<typeof SessionDiagnostics>;

// ---------------------------------------------------------------------------
// Inference scheduling + resource management (AI-5c)
// ---------------------------------------------------------------------------

/**
 * Relative scheduling importance of a session. Under saturation the scheduler serves higher
 * priorities first and degrades lower ones first — so a loading-dock camera can be sacrificed to
 * keep the entrance camera real-time, which is a business decision expressed as configuration.
 */
export const SessionPriority = z.enum(['low', 'normal', 'high', 'critical']);
export type SessionPriority = z.infer<typeof SessionPriority>;

/** Numeric weight per priority — the scheduler's fair-share multiplier. */
export const PRIORITY_WEIGHTS: Record<SessionPriority, number> = {
  low: 1,
  normal: 2,
  high: 4,
  critical: 8,
};

/**
 * How the scheduler picks the next frame across sessions.
 *   - `round-robin`    — strict rotation; every camera gets an equal turn regardless of priority.
 *   - `weighted-fair`  — rotation weighted by `SessionPriority` (default): fair, but importance-aware.
 *   - `strict-priority`— always serve the highest priority with work; starves lower ones under load.
 * Fairness is the default because the failure mode it prevents (one busy camera starving seven
 * others) is far more common in practice than the one strict priority prevents.
 */
export const SchedulingStrategy = z.enum(['round-robin', 'weighted-fair', 'strict-priority']);
export type SchedulingStrategy = z.infer<typeof SchedulingStrategy>;

/**
 * The **ordered degradation ladder** (Architect AI-5c rec 3) — graceful degradation instead of hard
 * failure. Each rung costs more analytical quality than the one before, so the runtime always spends
 * the cheapest quality first:
 *
 *   1. `none`               — full quality.
 *   2. `reduced-fps`        — analyze fewer frames per second (coarser sampling stride).
 *   3. `reduced-resolution` — analyze smaller frames (cheaper decode + inference).
 *   4. `reduced-behaviors`  — disable the most expensive behavior analyzers, keep detection/tracking.
 *   5. `shedding-frames`    — bounded-queue overflow; genuine loss.
 *   6. `suspended`          — the session stops consuming, but is NOT failed and NOT forgotten.
 *
 * A camera analyzing at 2 fps still detects intruders; a failed session detects nothing. Suspension
 * is the last resort and is always reversible — recovery walks back DOWN the same ladder.
 */
export const DegradationLevel = z.enum([
  'none',
  'reduced-fps',
  'reduced-resolution',
  'reduced-behaviors',
  'shedding-frames',
  'suspended',
]);
export type DegradationLevel = z.infer<typeof DegradationLevel>;

/** The ladder in escalation order — index = severity. Recovery walks it in reverse. */
export const DEGRADATION_LADDER = [
  'none',
  'reduced-fps',
  'reduced-resolution',
  'reduced-behaviors',
  'shedding-frames',
  'suspended',
] as const satisfies readonly DegradationLevel[];

// ---------------------------------------------------------------------------
// Compute resources — hardware-independent (Architect AI-5c rec 1)
// ---------------------------------------------------------------------------

/**
 * A class of compute the runtime can schedule work onto. Deliberately open-ended and
 * **hardware-independent**: the scheduler reasons about *capacity and cost*, never about CUDA
 * specifics, so adding TensorRT or Metal is a registry entry, not a scheduler change. This mirrors
 * how `ModelAdapter` (ADR-0012) keeps the pipeline engine-agnostic.
 */
export const ComputeResourceKind = z.enum([
  'cpu',
  'cuda',
  'tensorrt',
  'openvino',
  'metal',
  'tpu',
  'npu',
]);
export type ComputeResourceKind = z.infer<typeof ComputeResourceKind>;

/**
 * One schedulable compute resource. `capacityUnits` is an abstract, dimensionless budget — NOT cores,
 * NOT VRAM — because the one thing every accelerator shares is "how much concurrent work fits".
 * Expressing capacity abstractly is what lets the same scheduler run unchanged on a laptop CPU and a
 * multi-GPU box, and is also what makes a future distributed scheduler possible (rec 8): a remote
 * node is just another `ComputeResource` with an id.
 */
export const ComputeResource = z.object({
  /** Stable id, e.g. `cpu:0`, `cuda:0`. Node-qualified (`node-a/cuda:0`) in a clustered deployment. */
  id: z.string().min(1).max(200),
  kind: ComputeResourceKind,
  /** Human label, e.g. "NVIDIA RTX 4070". Descriptive only. */
  label: z.string().max(200).optional(),
  /** Abstract concurrent-work budget. Consumers compare *shares*, never absolute hardware units. */
  capacityUnits: z.number().positive().default(1),
  /** Units currently committed to admitted sessions. */
  allocatedUnits: z.number().nonnegative().default(0),
  /** Whether the runtime may place new work here. */
  available: z.boolean().default(true),
  /** Optional observed utilisation (%) — best-effort, absent where not probeable. */
  utilizationPercent: z.number().min(0).max(100).optional(),
  memoryMb: z.number().nonnegative().optional(),
});
export type ComputeResource = z.infer<typeof ComputeResource>;

/** What one session is estimated to cost — the input to admission control (rec 5). */
export const ResourceEstimate = z.object({
  /** Abstract compute units the session is expected to consume. */
  computeUnits: z.number().nonnegative().default(0),
  memoryMb: z.number().nonnegative().default(0),
  /** Frames per second the session intends to analyze. */
  targetFps: z.number().positive().default(5),
  /** Expected per-frame inference cost (ms) on the target resource. */
  estimatedInferenceMs: z.number().nonnegative().default(0),
});
export type ResourceEstimate = z.infer<typeof ResourceEstimate>;

/**
 * Why admission was refused — distinct causes need distinct operator responses. "Add a bigger box"
 * fixes `compute-capacity`; it does NOT fix `reserve-protected` (raise the priority or lower the
 * reserve) or `no-compatible-resource` (install the right accelerator).
 */
export const AdmissionRefusalReason = z.enum([
  'session-capacity',
  'compute-capacity',
  'memory-capacity',
  'throughput-capacity',
  'no-compatible-resource',
  /** Only the reserved headroom remained, and this priority may not draw on it (refinement 1). */
  'reserve-protected',
]);
export type AdmissionRefusalReason = z.infer<typeof AdmissionRefusalReason>;

/**
 * The result of admission control (rec 5). A session is admitted only when the runtime can serve it
 * **safely** — accepting work it cannot run degrades every session already running, which is the
 * failure mode admission control exists to prevent.
 */
export const AdmissionVerdict = z.object({
  admitted: z.boolean(),
  /** The resource the session was placed on, when admitted. */
  resourceId: z.string().min(1).max(200).optional(),
  reason: AdmissionRefusalReason.optional(),
  /** Operator-readable explanation, always present — a refusal must never be silent. */
  detail: z.string().max(500),
  estimate: ResourceEstimate.optional(),
  /** Headroom left after admitting (or that would remain), for capacity planning. */
  remainingUnits: z.number().nonnegative().optional(),
});
export type AdmissionVerdict = z.infer<typeof AdmissionVerdict>;

/** What the scheduler did, and why (rec 4) — the production-diagnostics record. */
export const SchedulerAction = z.enum([
  'admitted',
  'refused',
  'scheduled',
  'throttled',
  'degraded',
  'recovered',
  'suspended',
  'resumed',
  'released',
]);
export type SchedulerAction = z.infer<typeof SchedulerAction>;

/** Why the scheduler acted — a closed set, so decisions are queryable rather than free text. */
export const SchedulerReason = z.enum([
  'queue-pressure',
  'cpu-pressure',
  'memory-pressure',
  'gpu-pressure',
  'compute-exhausted',
  'session-capacity',
  'priority-preemption',
  'pressure-relieved',
  'fair-share',
  'operator-request',
  /** Degraded on a projected overload, before the queue actually filled (refinement 2). */
  'predicted-pressure',
  /** Refused because only the reserve remained and this priority may not draw on it (refinement 1). */
  'reserve-protected',
  /**
   * Degraded because the HEALTH SCORE is projected to decline past its threshold (AI-5d rec 1).
   * Health produces the evidence; the governor remains the only thing that moves a session down the
   * ladder — two components able to degrade a session is how you get oscillation nobody can debug.
   */
  'predicted-health-decline',
  /** Held at the current rung because the session is inside its post-recovery stabilization window. */
  'stabilizing',
]);
export type SchedulerReason = z.infer<typeof SchedulerReason>;

/**
 * One recorded scheduler decision (rec 4). Answers the question an operator actually asks at 3am —
 * "why did THIS camera get throttled?" — with the session identity, the action, the reason, and the
 * measurement that triggered it.
 */
export const SchedulerDecision = z.object({
  identity: SessionIdentity,
  action: SchedulerAction,
  reason: SchedulerReason,
  /** Degradation transition, when the action changed it. */
  fromLevel: DegradationLevel.optional(),
  toLevel: DegradationLevel.optional(),
  /** The measurement that triggered the decision, e.g. `{ queueUtilization: 91.2 }`. */
  measurement: z.record(z.string(), z.number()).default({}),
  detail: z.string().max(500).optional(),
  at: IsoDateTime.optional(),
});
export type SchedulerDecision = z.infer<typeof SchedulerDecision>;

/**
 * Per-session SLA tracking (rec 6) — target vs actual, so scheduling decisions are **data-driven**
 * rather than heuristic. `met` is the single question an operator cares about: is this camera getting
 * the service it was promised?
 */
export const SessionSla = z.object({
  identity: SessionIdentity,
  targetFps: z.number().positive(),
  actualFps: z.number().nonnegative().default(0),
  /** Target end-to-end event latency (ms), from the deployment profile. */
  targetLatencyMs: z.number().positive().optional(),
  actualLatencyMs: z.number().nonnegative().default(0),
  queueDepth: z.number().int().nonnegative().default(0),
  droppedFrames: z.number().int().nonnegative().default(0),
  health: SessionHealth.default('unknown'),
  degradation: DegradationLevel.default('none'),
  /** Whether the session is currently meeting its FPS (and latency, when targeted) commitment. */
  met: z.boolean().default(true),
  /** actualFps / targetFps as a percentage — the headline attainment number. */
  attainmentPercent: z.number().min(0).default(100),
});
export type SessionSla = z.infer<typeof SessionSla>;

/** Scheduler configuration — policy, not code (Architect AI-5a rec 5: scheduler must be policy-driven). */
export const SchedulerPolicy = z.object({
  strategy: SchedulingStrategy.default('weighted-fair'),
  /** Max frames handed to the model per scheduling pass (1 = no batching). */
  maxBatchSize: z.number().int().min(1).max(64).default(1),
  /** Frames a single session may take consecutively before the scheduler rotates (anti-starvation). */
  maxConsecutivePerSession: z.number().int().min(1).max(100).default(4),
  /** Queue utilization (%) above which the governor starts degrading. */
  degradeAboveQueuePercent: z.number().min(0).max(100).default(80),
  /** Queue utilization (%) below which a degraded session recovers. Must be < degradeAboveQueuePercent. */
  recoverBelowQueuePercent: z.number().min(0).max(100).default(50),
  /** Process CPU (%) above which the governor degrades. */
  cpuCeilingPercent: z.number().min(0).max(100).optional(),
  /** Process resident memory (MB) above which the governor degrades. */
  memoryCeilingMb: z.number().positive().optional(),
  /** Lowest sampling FPS degradation may fall to — below this a session is suspended, not starved. */
  minDegradedFps: z.number().positive().max(120).default(1),
  /** Highest rung the governor may climb. Caps degradation for deployments that must never suspend. */
  maxDegradation: DegradationLevel.default('suspended'),
  /** Scale factor applied to frame dimensions at the `reduced-resolution` rung. */
  reducedResolutionScale: z.number().min(0.1).max(1).default(0.5),
  /** Consecutive pressure observations required before escalating (anti-flapping). */
  escalateAfterSamples: z.number().int().min(1).max(100).default(2),
  /** Consecutive relief observations required before recovering a rung (anti-flapping). */
  recoverAfterSamples: z.number().int().min(1).max(100).default(3),
  /** Admission control: refuse sessions the runtime cannot serve safely (rec 5). */
  admissionControl: z.boolean().default(true),
  /**
   * Percentage of total compute capacity held back from ordinary admission (AI-5c refinement 1).
   * The reserve exists so a `critical` session can still start, and so a recovering session has room
   * to re-connect, when the box is otherwise full. Without it, a runtime at 100% utilization cannot
   * recover from its own success — every unit is committed and nothing can restart.
   */
  reservedCapacityPercent: z.number().min(0).max(50).default(10),
  /** Priorities allowed to draw on the reserve. */
  reserveFor: z.array(SessionPriority).default(['critical']),
  /**
   * Degrade on a *predicted* overload rather than an observed one (refinement 2). Reacting only once
   * the queue is full means frames have already been lost; a rising trend is actionable while there is
   * still headroom to act.
   */
  predictive: z.boolean().default(true),
  /** Observations retained per session for trend estimation. */
  trendWindowSamples: z.number().int().min(2).max(100).default(5),
  /**
   * Projected utilization (%) at the trend horizon that triggers pre-emptive degradation. Only used
   * when `predictive` is true.
   */
  predictedPressureThreshold: z.number().min(0).max(200).default(95),
  /** How many samples ahead the trend is projected. */
  predictionHorizonSamples: z.number().int().min(1).max(50).default(3),
});
export type SchedulerPolicy = z.infer<typeof SchedulerPolicy>;

/**
 * Approximate computational cost per analyzer (AI-5c refinement 4). Optional and descriptive: when
 * present, the governor disables the **most expensive** analyzers first at the `reduced-behaviors`
 * rung, instead of treating a cheap occupancy count and an expensive crowd-density estimate as equal.
 * Costs are relative units, not milliseconds — the ordering is what matters, and ordering survives
 * hardware changes in a way absolute timings do not.
 */
export const AnalyzerCostModel = z.object({
  /** analyzer name → relative cost (default 1.0 when unlisted). */
  costs: z.record(z.string(), z.number().nonnegative()).default({}),
  /** Analyzers that must never be disabled by degradation, whatever the pressure. */
  protectedAnalyzers: z.array(z.string()).default([]),
});
export type AnalyzerCostModel = z.infer<typeof AnalyzerCostModel>;

/** A point-in-time process resource sample (best-effort; GPU present only where probeable). */
export const ResourceSnapshot = z.object({
  cpuPercent: z.number().nonnegative().optional(),
  memoryMb: z.number().nonnegative().optional(),
  gpuPercent: z.number().nonnegative().optional(),
  gpuMemoryMb: z.number().nonnegative().optional(),
  /** Logical cores visible to the process — the denominator for CPU share. */
  logicalCores: z.number().int().positive().optional(),
  at: IsoDateTime.optional(),
});
export type ResourceSnapshot = z.infer<typeof ResourceSnapshot>;

/**
 * Per-session operational accounting (Architect AI-5b rec 3) — what one camera actually costs.
 * Critical when scaling to many concurrent cameras: without it, "the box is at 90% CPU" is not
 * actionable, because nobody knows which of 30 sessions to move, downgrade, or suspend.
 *
 * CPU/memory/GPU are **attributed shares**, not kernel-measured per-thread figures: the runtime is one
 * process, so a session's share is estimated from its measured work (frames × inference time) against
 * the process total. Honest attribution beats false precision — the field docs say so explicitly.
 */
export const SessionResourceUsage = z.object({
  identity: SessionIdentity,
  priority: SessionPriority.default('normal'),
  degradation: DegradationLevel.default('none'),
  /** Estimated share of process CPU attributable to this session. */
  cpuPercent: z.number().nonnegative().optional(),
  /** Estimated share of process resident memory attributable to this session. */
  memoryMb: z.number().nonnegative().optional(),
  gpuPercent: z.number().nonnegative().optional(),
  averageQueueDepth: z.number().nonnegative().default(0),
  queueUtilization: z.number().min(0).max(100).default(0),
  /** Mean model inference time per frame (ms). */
  inferenceLatencyMs: z.number().nonnegative().default(0),
  /** Mean frame-capture → EventEnvelope latency (ms). */
  eventLatencyMs: z.number().nonnegative().default(0),
  reconnectCount: z.number().int().nonnegative().default(0),
  framesProcessed: z.number().int().nonnegative().default(0),
  /** Effective analysis FPS after any degradation. */
  effectiveFps: z.number().nonnegative().default(0),
  /** Analyzers currently disabled by degradation (AI-5d) — restored in exact reverse order. */
  disabledAnalyzers: z.array(z.string().min(1)).default([]),
  /** Latest composite health score (AI-5d), when health monitoring is enabled. */
  healthScore: z.number().min(0).max(100).optional(),
});
export type SessionResourceUsage = z.infer<typeof SessionResourceUsage>;

/** Scheduler observability — how work was actually distributed across sessions. */
export const SchedulerStats = z.object({
  strategy: SchedulingStrategy,
  /** Sessions currently registered with the scheduler. */
  registeredSessions: z.number().int().nonnegative().default(0),
  /** Scheduling passes executed. */
  passes: z.number().int().nonnegative().default(0),
  framesScheduled: z.number().int().nonnegative().default(0),
  /** Batches dispatched (equals framesScheduled when maxBatchSize is 1). */
  batchesDispatched: z.number().int().nonnegative().default(0),
  averageBatchSize: z.number().nonnegative().default(0),
  /** Sessions skipped this pass because another was mid-quota (anti-starvation bookkeeping). */
  rotations: z.number().int().nonnegative().default(0),
  /** Per-session share of scheduled frames, keyed by sessionId — the fairness proof. */
  sharesBySession: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** Sessions currently degraded, by level. */
  degradedSessions: z.record(z.string(), z.number().int().nonnegative()).default({}),
  resources: ResourceSnapshot.optional(),
  /** Compute resources the scheduler is placing work on (hardware-independent view, rec 1). */
  computeResources: z.array(ComputeResource).default([]),
  /** Most recent decisions, newest first — bounded (rec 4). */
  recentDecisions: z.array(SchedulerDecision).default([]),
  admissionsRefused: z.number().int().nonnegative().default(0),
});
export type SchedulerStats = z.infer<typeof SchedulerStats>;

// ---------------------------------------------------------------------------
// Health monitoring (AI-5d) — health as a SCORE and a TREND, not a boolean
// ---------------------------------------------------------------------------

/**
 * The five operational domains a session's health decomposes into (Architect AI-5d rec 2). A single
 * `overallHealth = 83` tells an operator that something is wrong but not *what*; component scores
 * (`connection: 98, inference: 81, scheduler: 76, resources: 92, recovery: 100`) point straight at
 * the subsystem to look at, which is the difference between a 5-minute and a 50-minute diagnosis.
 */
export const HealthComponent = z.enum([
  'connection',
  'inference',
  'scheduler',
  'resources',
  'recovery',
]);
export type HealthComponent = z.infer<typeof HealthComponent>;

/**
 * One measured input to the health score. Every indicator is derived from a measurement the runtime
 * ALREADY produces (AI-5b ingestion/backpressure stats, AI-5c accounts) — health monitoring adds no
 * new instrumentation, it interprets what is already there.
 *
 * `frame-loss` is genuine backpressure loss (`framesDropped`) and never sampling (`framesSkipped`) —
 * conflating them would report a healthy runtime as sick every time an operator lowered the FPS.
 */
export const HealthIndicatorName = z.enum([
  'stream-availability',
  'reconnect-frequency',
  'inference-latency',
  'event-latency',
  'queue-growth',
  'frame-loss',
  'sla-attainment',
  'cpu-utilization',
  'memory-utilization',
  'recovery-attempts',
  'restart-frequency',
  'degradation-level',
]);
export type HealthIndicatorName = z.infer<typeof HealthIndicatorName>;

/** Which direction an indicator (or a whole score) is moving — the predictive half of health. */
export const HealthTrend = z.enum(['improving', 'stable', 'deteriorating']);
export type HealthTrend = z.infer<typeof HealthTrend>;

/**
 * One scored indicator: what was measured, what it scored (0–100, higher is healthier), and which
 * way it is moving. `measured` is kept alongside `score` deliberately — an operator needs the raw
 * number ("queue at 91%") as well as the normalized one, because only the raw number is actionable.
 */
export const HealthIndicator = z.object({
  name: HealthIndicatorName,
  component: HealthComponent,
  /** Normalized health of this indicator: 100 = perfect, 0 = as bad as this indicator gets. */
  score: z.number().min(0).max(100),
  /** The raw measurement the score was derived from (units depend on the indicator). */
  measured: z.number().optional(),
  /** Per-sample slope of the underlying trend; negative means the measurement is falling. */
  slope: z.number().optional(),
  trend: HealthTrend.default('stable'),
  /** Relative weight inside its component. */
  weight: z.number().positive().default(1),
  detail: z.string().max(300).optional(),
});
export type HealthIndicator = z.infer<typeof HealthIndicator>;

/**
 * A session's composite operational health (Architect AI-5d recs 1 + 2).
 *
 * Two properties make this useful rather than decorative:
 *   - **Decomposed** — `components` says which subsystem is dragging the score down (rec 2).
 *   - **Projected** — `projectedScore` is where the score is heading if current trends continue
 *     (rec 1). Acting on a projection is what makes degradation preventive instead of reactive.
 *
 * `status` maps the score onto the SAME four values as the state-derived `SessionHealth`, and state
 * always wins: a `stopped` session is `down` at any score. The score explains *why*; it never
 * contradicts *what*.
 */
export const HealthScore = z.object({
  identity: SessionIdentity,
  /** Weighted composite of the component scores, 0–100. */
  score: z.number().min(0).max(100),
  status: SessionHealth,
  /**
   * Per-subsystem scores — the operator's first question, answered without drilling in (rec 2).
   * Every component is REQUIRED: a health report that omits a subsystem is exactly the report that
   * sends someone looking in the wrong place, so the shape makes omission impossible.
   */
  components: z.record(HealthComponent, z.number().min(0).max(100)),
  indicators: z.array(HealthIndicator).default([]),
  trend: HealthTrend.default('stable'),
  /** Score projected `projectionHorizonSamples` observations ahead, if trends continue (rec 1). */
  projectedScore: z.number().min(0).max(100).optional(),
  projectedStatus: SessionHealth.optional(),
  /** Set when the projection (not the current score) is what crosses a threshold. */
  predictedDecline: z.boolean().default(false),
  /** Observations recorded so far — a score from 1 sample is not yet a trend, and says so. */
  samples: z.number().int().nonnegative().default(0),
  /**
   * Rolling per-component history, oldest first (Architect AI-5d follow-up rec 2). Operators care
   * more about the shape than about any single value: `82` means little, `98 → 94 → 88 → 82` means
   * something is going wrong right now.
   */
  componentTrends: z.partialRecord(HealthComponent, z.array(z.number().min(0).max(100))).optional(),
  at: IsoDateTime.optional(),
});
export type HealthScore = z.infer<typeof HealthScore>;

/** Health scoring configuration — thresholds and weights as policy, never as constants in code. */
export const HealthPolicy = z.object({
  /** Relative weight of each component in the composite score; unlisted components use 1.0. */
  componentWeights: z.partialRecord(HealthComponent, z.number().nonnegative()).optional(),
  /** Score at/below which a session is `degraded`. */
  degradedBelow: z.number().min(0).max(100).default(80),
  /** Score at/below which a session is `down`-grade unhealthy. */
  unhealthyBelow: z.number().min(0).max(100).default(50),
  trendWindowSamples: z.number().int().min(2).max(100).default(5),
  projectionHorizonSamples: z.number().int().min(1).max(50).default(3),
  /** Whether a projected decline may trigger preventive degradation (rec 1). */
  predictiveDegradation: z.boolean().default(true),
  /** Consecutive healthy observations required before health is considered stabilized (rec 6). */
  stabilizationSamples: z.number().int().min(1).max(100).default(3),
});
export type HealthPolicy = z.infer<typeof HealthPolicy>;

// ---------------------------------------------------------------------------
// Auto-recovery (AI-5d) — recovery as a policy-driven, budgeted, auditable act
// ---------------------------------------------------------------------------

/** Which tier a recovery originated in — the five AI-5b ownership tiers, plus the model. */
export const RecoverySubsystem = z.enum([
  'stream-source',
  'stream-pipeline',
  'video-analyzer',
  'model',
  'scheduler',
  'session-runner',
  'configuration',
]);
export type RecoverySubsystem = z.infer<typeof RecoverySubsystem>;

/** How serious the originating condition was (drives alerting, not runtime behavior). */
export const RecoverySeverity = z.enum(['info', 'warning', 'error', 'critical']);
export type RecoverySeverity = z.infer<typeof RecoverySeverity>;

/** What prompted a recovery — a closed set, so recoveries are queryable rather than free text. */
export const RecoveryTrigger = z.enum([
  'connection-lost',
  'reconnect-exhausted',
  'model-failure',
  'inference-failure',
  'pipeline-failure',
  'configuration-failure',
  'health-decline',
  'stall-detected',
  'operator-request',
]);
export type RecoveryTrigger = z.infer<typeof RecoveryTrigger>;

/**
 * The structured "why" behind a recovery (Architect AI-5d rec 1). Recording only that a recovery
 * *happened* leaves an incident review guessing; recording the trigger, the tier it came from, the
 * severity, which attempt it was, and the correlation id turns a night of restarts into one query.
 */
export const RecoveryReason = z.object({
  trigger: RecoveryTrigger,
  /** Where the condition originated — never where it was *noticed*. */
  subsystem: RecoverySubsystem,
  severity: RecoverySeverity.default('error'),
  /** Which attempt this is within the current recovery budget window (1-based). */
  retryCount: z.number().int().nonnegative().default(0),
  /** Correlates this recovery with the request/session trace that produced it. */
  correlationId: z.string().min(1).max(200).optional(),
  /** The frozen AI-5b failure category, when a failure (rather than health) triggered recovery. */
  failureCategory: RuntimeFailureCategory.optional(),
  /** The stable diagnostic code (`AI-CONN`, `AI-MODEL`, …) for log/alert correlation. */
  failureCode: z.string().min(1).max(40).optional(),
  detail: z.string().max(500).optional(),
  at: IsoDateTime,
});
export type RecoveryReason = z.infer<typeof RecoveryReason>;

/**
 * What the runtime does about a condition. Each maps 1:1 onto the recovery path the frozen AI-5b
 * failure taxonomy already declares, so recovery adds no new judgement — it *executes* the taxonomy.
 */
export const RecoveryAction = z.enum([
  'none',
  'reconnect',
  'rebind-model',
  'skip-frame',
  'restart-session',
  'degrade',
  'operator-intervention',
]);
export type RecoveryAction = z.infer<typeof RecoveryAction>;

/** How a recovery attempt ended. A refusal is an outcome, not an error — and is always explained. */
export const RecoveryOutcome = z.enum([
  'succeeded',
  'failed',
  'deferred',
  'budget-exhausted',
  'cooldown',
  'operator-required',
  'blocked-by-policy',
]);
export type RecoveryOutcome = z.infer<typeof RecoveryOutcome>;

/** One recorded recovery attempt — reason, action, outcome. The audit unit for rec 1 + rec 5. */
export const RecoveryAttempt = z.object({
  identity: SessionIdentity,
  reason: RecoveryReason,
  action: RecoveryAction,
  outcome: RecoveryOutcome,
  /** Attempt number within the budget window. */
  attempt: z.number().int().positive().default(1),
  /** Backoff applied before the next attempt, when one is scheduled. */
  cooldownMs: z.number().nonnegative().optional(),
  detail: z.string().max(500).optional(),
  at: IsoDateTime.optional(),
});
export type RecoveryAttempt = z.infer<typeof RecoveryAttempt>;

/**
 * Recovery budgets as **external configuration** (Architect AI-5d rec 4). The same runtime must be
 * able to behave as a retail store (restart 3 times, then stop bothering anyone), a factory (10),
 * a bank (indefinitely, with long cooldowns), or a hospital (never restart without an operator) —
 * and those are policy decisions belonging to a deployment profile, not to runtime code.
 */
export const RecoveryPolicy = z.object({
  /** Restarts allowed inside `restartWindowSeconds`. Ignored when `unlimitedRestarts` is set. */
  maxRestarts: z.number().int().min(0).max(1000).default(3),
  /** Rolling window the budget is counted over. */
  restartWindowSeconds: z.number().positive().max(86400).default(3600),
  /** Restart forever (banks/critical infrastructure) — always paired with a long cooldown. */
  unlimitedRestarts: z.boolean().default(false),
  baseCooldownMs: z.number().nonnegative().default(5000),
  maxCooldownMs: z.number().nonnegative().default(300000),
  /** Healthcare-style: never auto-restart; surface the condition and wait for a human. */
  requireOperatorApproval: z.boolean().default(false),
  /**
   * Seconds a session must stay healthy after a recovery before another transition is allowed
   * (rec 6) — the anti-oscillation guard. Without it a marginal camera flaps forever.
   */
  stabilizationSeconds: z.number().nonnegative().max(3600).default(30),
  /** Failure categories eligible for automatic recovery. `configuration` is NEVER retried. */
  autoRecoverCategories: z.array(RuntimeFailureCategory).default(['connection', 'model']),
});
export type RecoveryPolicy = z.infer<typeof RecoveryPolicy>;

/**
 * One permanently-retained recovery outcome (Architect AI-5d follow-up rec 1).
 *
 * Deliberately distinct from `RecoveryAttempt`, which is the in-flight decision record and is
 * released when a session tears down. This survives teardown, because the question it answers —
 * "this camera has failed the same way for three weeks" — is unanswerable from a store that forgets
 * every time the session restarts.
 */
export const RecoveryRecord = z.object({
  identity: SessionIdentity,
  /** The frozen AI-5b category, absent when health (not a failure) triggered the recovery. */
  failureCategory: RuntimeFailureCategory.optional(),
  trigger: RecoveryTrigger,
  subsystem: RecoverySubsystem,
  action: RecoveryAction,
  outcome: RecoveryOutcome,
  attempt: z.number().int().positive().default(1),
  /** Wall time spent on the whole decision, not only the executor — a recovery that spent four
   * seconds deciding it was not allowed still cost four seconds. */
  durationMs: z.number().nonnegative().default(0),
  restartCount: z.number().int().nonnegative().default(0),
  stabilizationSeconds: z.number().nonnegative().default(0),
  /** The session state the recovery actually left behind, resolved after the executor ran. */
  finalState: z.string().min(1).max(40).default('unknown'),
  at: IsoDateTime,
});
export type RecoveryRecord = z.infer<typeof RecoveryRecord>;

/**
 * Long-term failure statistics (Architect AI-5d follow-up rec 5).
 *
 * **Operational reporting, never a runtime input.** Nothing in the scheduler, governor or recovery
 * path reads these; feeding last week's averages into a live control loop is how a system starts
 * reacting to history instead of to conditions.
 *
 * Averages cover **executed** recoveries only — including refusals would drag the mean toward zero
 * and make a deployment that never recovers look like the fastest one of all.
 */
export const FailureAnalytics = z.object({
  recoveries: z.number().int().nonnegative().default(0),
  /** Occurrences per failure category (or per trigger, when there was no failure category). */
  byCategory: z.record(z.string(), z.number().int().nonnegative()).default({}),
  byOutcome: z.record(z.string(), z.number().int().nonnegative()).default({}),
  successPercent: z.number().min(0).max(100).default(0),
  averageRecoveryMs: z.number().nonnegative().default(0),
  averageStabilizationSeconds: z.number().nonnegative().default(0),
  restartsTotal: z.number().int().nonnegative().default(0),
  /** The category to look at first. Null only when nothing has ever been recovered. */
  mostCommonFailure: z.string().min(1).max(60).nullable().default(null),
  camerasAffected: z.number().int().nonnegative().default(0),
});
export type FailureAnalytics = z.infer<typeof FailureAnalytics>;

/**
 * One entry on the **restoration stack** (Architect AI-5d rec 4, accepted as the permanent recovery
 * mechanism). A rung is not what was actually taken away — `reduced-behaviors` disabled *specific*
 * analyzers, and re-enabling different ones is not the reverse. Each degradation pushes exactly what
 * it removed; each recovery pops it, which makes exact-reverse restoration structural rather than
 * merely intended.
 */
export const RestoreStep = z.object({
  /** The rung this step entered (i.e. what must be undone to leave it). */
  level: DegradationLevel,
  /** Monotonic push order — recovery pops strictly descending. */
  sequence: z.number().int().nonnegative(),
  /** Analyzers this step disabled, in the order they were disabled. */
  disabledAnalyzers: z.array(z.string().min(1)).default([]),
  fpsBefore: z.number().nonnegative().optional(),
  fpsAfter: z.number().nonnegative().optional(),
  resolutionScale: z.number().positive().max(1).optional(),
  at: IsoDateTime.optional(),
});
export type RestoreStep = z.infer<typeof RestoreStep>;

// ---------------------------------------------------------------------------
// Model lifecycle (AI-5d) — zero-downtime version transitions
// ---------------------------------------------------------------------------

/**
 * The staged transition an active model version goes through (Architect AI-5d rec 3):
 *
 *   active(vN) → warming → validating → switching → draining → active(vN+1)
 *                              └── failed validation ──→ rolled-back(vN)
 *
 * The switch is a **binding swap read per frame**, so no running session restarts and no frame is
 * lost. `draining` keeps the outgoing model warm long enough for in-flight frames to finish on the
 * model that started them — swapping under a frame mid-pipeline is how you get results that belong
 * to neither version.
 */
export const ModelTransitionState = z.enum([
  'pending',
  'warming',
  'validating',
  'switching',
  'draining',
  'active',
  'rolled-back',
  'failed',
]);
export type ModelTransitionState = z.infer<typeof ModelTransitionState>;

/**
 * The **operational** validation checks a candidate must pass. Deliberately NOT accuracy checks:
 * without labelled footage a runtime cannot certify recall, and a contract implying otherwise would
 * be a lie an operator might trust. These catch the failures that actually break a deployment — a
 * corrupt artifact, a wrong input shape, a 10× latency regression, a model that silently detects
 * nothing. Accuracy validation belongs to AI-5e certification with labelled footage.
 */
export const ModelValidationCheckName = z.enum([
  'artifact-loads',
  'inference-runs',
  'output-structure',
  'latency-budget',
  'detection-comparability',
]);
export type ModelValidationCheckName = z.infer<typeof ModelValidationCheckName>;

/** One validation check — pass/fail plus the measurement and the budget it was judged against. */
export const ModelValidationCheck = z.object({
  name: ModelValidationCheckName,
  passed: z.boolean(),
  measured: z.number().optional(),
  budget: z.number().optional(),
  detail: z.string().max(500).optional(),
});
export type ModelValidationCheck = z.infer<typeof ModelValidationCheck>;

/** The verdict on a candidate version. `passed` is the AND of every check. */
export const ModelValidationResult = z.object({
  passed: z.boolean(),
  checks: z.array(ModelValidationCheck).default([]),
  framesEvaluated: z.number().int().nonnegative().default(0),
  candidateLatencyMs: z.number().nonnegative().optional(),
  /** The incumbent's latency over the same frames — the only fair comparison. */
  incumbentLatencyMs: z.number().nonnegative().optional(),
  candidateDetections: z.number().int().nonnegative().optional(),
  incumbentDetections: z.number().int().nonnegative().optional(),
  at: IsoDateTime.optional(),
});
export type ModelValidationResult = z.infer<typeof ModelValidationResult>;

/** One state change inside a transition — the fine-grained audit trail (rec 3). */
export const ModelTransitionEvent = z.object({
  state: ModelTransitionState,
  at: IsoDateTime,
  detail: z.string().max(500).optional(),
});
export type ModelTransitionEvent = z.infer<typeof ModelTransitionEvent>;

/**
 * One staged model version transition, start to finish. Kept queryable forever (rec 3) because the
 * question an incident review asks — "what changed on this model, and when?" — is unanswerable
 * from a registry that only stores the *current* active version.
 */
export const ModelTransition = z.object({
  id: z.string().min(1).max(100),
  tenantId: TenantId,
  modelId: z.string().min(1).max(100),
  /** Null on the very first activation — there was no incumbent to come from. */
  fromVersion: z.string().min(1).max(100).nullable(),
  toVersion: z.string().min(1).max(100),
  state: ModelTransitionState,
  validation: ModelValidationResult.optional(),
  /** Why a rollback happened — always present when `state` is `rolled-back`. */
  rollbackReason: z.string().max(500).optional(),
  /** Sessions that stayed running across the switch — the zero-downtime evidence. */
  sessionsAffected: z.number().int().nonnegative().default(0),
  history: z.array(ModelTransitionEvent).default([]),
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: IsoDateTime.optional(),
});
export type ModelTransition = z.infer<typeof ModelTransition>;

/**
 * The full lifecycle history of one model (rec 3). `versionPath` is the compact answer — e.g.
 * `['v1','v2','v1','v3','v4']` reads as "v2 was tried and rolled back" at a glance.
 */
export const ModelLifecycleHistory = z.object({
  tenantId: TenantId,
  modelId: z.string().min(1).max(100),
  activeVersion: z.string().min(1).max(100).nullable(),
  versionPath: z.array(z.string().min(1)).default([]),
  transitions: z.array(ModelTransition).default([]),
});
export type ModelLifecycleHistory = z.infer<typeof ModelLifecycleHistory>;

/** Model-transition policy — validation strictness, drain window, and rollback behavior. */
export const ModelLifecyclePolicy = z.object({
  /** Frames the candidate is evaluated over during `validating`. */
  validationFrames: z.number().int().min(1).max(10000).default(20),
  /** Absolute latency ceiling for the candidate (ms). */
  maxValidationLatencyMs: z.number().positive().optional(),
  /** Candidate latency may exceed the incumbent's by at most this percentage. */
  latencyRegressionPercent: z.number().min(0).max(1000).default(25),
  /** Candidate detection count may differ from the incumbent's by at most this percentage. */
  detectionDeltaPercent: z.number().min(0).max(100).default(50),
  /** How long the outgoing model stays warm so in-flight frames finish on it. */
  drainMs: z.number().nonnegative().max(600000).default(1000),
  /** Roll back automatically when validation fails (rather than parking in `failed`). */
  autoRollback: z.boolean().default(true),
  /** Whether a transition may skip validation. Off by default — that is the whole point. */
  requireValidation: z.boolean().default(true),
});
export type ModelLifecyclePolicy = z.infer<typeof ModelLifecyclePolicy>;

// ---------------------------------------------------------------------------
// Operational diagnostics (AI-5d) — one correlated journal + an ordered timeline
// ---------------------------------------------------------------------------

/** Which operational concern an entry came from — the journal's filter axis. */
export const DiagnosticKind = z.enum([
  'lifecycle',
  'connection',
  'scheduling',
  'degradation',
  'recovery',
  'model',
  'health',
  'failure',
]);
export type DiagnosticKind = z.infer<typeof DiagnosticKind>;

/**
 * One entry in a session's operational journal (Architect AI-5d rec 5). Admission, scheduling,
 * degradation, recovery, restart, model transitions and failures all land here with a timestamp and
 * the correlating identity — so an incident is one query, not a grep across interleaved camera logs.
 */
export const DiagnosticEntry = z.object({
  at: IsoDateTime,
  kind: DiagnosticKind,
  /** The structured event name, e.g. `stream.reconnecting`, `scheduler.degraded`. */
  event: z.string().min(1).max(120),
  level: z.enum(['info', 'warn', 'error']).default('info'),
  identity: SessionIdentity,
  detail: z.string().max(500).optional(),
  /** The numeric measurements that accompanied the event. */
  measurement: z.record(z.string(), z.number()).default({}),
});
export type DiagnosticEntry = z.infer<typeof DiagnosticEntry>;

/**
 * One line of the human-readable **operational timeline** (rec 5) — chronological, oldest first,
 * one short sentence per line:
 *
 *   `10:02 Connected · 10:10 Queue increasing · 10:11 Governor reduced FPS · 10:13 Health stabilized`
 *
 * The journal is the machine-queryable record; the timeline is what a human reads first.
 */
export const TimelineEntry = z.object({
  at: IsoDateTime,
  /** Wall-clock `HH:MM:SS` — the timeline is read by eye, so the time is pre-formatted. */
  time: z.string().min(1).max(20),
  kind: DiagnosticKind,
  /** A short human sentence, e.g. `Governor reduced FPS (queue-pressure)`. */
  label: z.string().min(1).max(200),
  level: z.enum(['info', 'warn', 'error']).default('info'),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

/**
 * The complete operational picture of one session (AI-5d) — the AI-5b stream diagnostics plus health,
 * recovery history, the journal and the timeline.
 *
 * Kept as a distinct document rather than extra fields on `SessionDiagnostics` because the two answer
 * different questions and are read by different consumers: `SessionDiagnostics` is "how is the
 * stream?", this is "how is the session, and what has happened to it?".
 */
export const SessionOperationalDiagnostics = z.object({
  identity: SessionIdentity,
  health: HealthScore,
  stream: SessionDiagnostics,
  degradation: DegradationLevel.default('none'),
  /** The restoration stack, deepest-first — exactly what recovery will give back, in order. */
  restoreStack: z.array(RestoreStep).default([]),
  recovery: z.array(RecoveryAttempt).default([]),
  journal: z.array(DiagnosticEntry).default([]),
  timeline: z.array(TimelineEntry).default([]),
});
export type SessionOperationalDiagnostics = z.infer<typeof SessionOperationalDiagnostics>;

/**
 * A reusable **operational** deployment profile (Architect AI-5b rec 4) — retail, warehouse, office,
 * school, hospital, factory, parking. It sets operational defaults (sampling rate, queue size,
 * reconnect policy, latency targets, scheduling) **without modifying runtime code**.
 *
 * Deliberately distinct from the AI-4 `BehaviorProfile`: that one configures *perception* (which
 * behaviors run, with what thresholds); this one configures *operations* (how hard the box works).
 * Keeping them separate means a hospital can run the retail behavior set on hospital-grade
 * operational settings without either profile knowing about the other.
 */
export const DeploymentProfile = z.object({
  /** Profile id, e.g. `warehouse`. Portable — carries no tenant/camera/site ids. */
  profile: z.string().min(1).max(100),
  version: SemVer.default('1.0.0'),
  description: z.string().max(1000).optional(),
  /** Default perception sampling rate for cameras in this deployment. */
  targetFps: z.number().positive().max(120).default(5),
  queueCapacity: z.number().int().min(1).max(4096).default(32),
  dropPolicy: z.enum(['drop-oldest', 'drop-newest']).default('drop-oldest'),
  maxSessions: z.number().int().min(1).max(512).default(8),
  defaultPriority: SessionPriority.default('normal'),
  scheduler: SchedulerPolicy.optional(),
  reconnect: z
    .object({
      maxAttempts: z.number().int().min(0).max(1000).default(10),
      baseMs: z.number().positive().default(500),
      maxMs: z.number().positive().default(30000),
    })
    .optional(),
  /** Operational latency target (ms) for this deployment — informational, feeds budgets/alerts. */
  targetEventLatencyMs: z.number().positive().optional(),
  /** Preferred camera stream profile name for analysis (e.g. `sub`). */
  preferredStreamProfile: z.string().min(1).max(100).optional(),
  /**
   * Behavior analyzers enabled for this deployment (AI-5c refinement 5). Empty = the runtime default
   * set. This is an OPERATIONAL selection (what this site can afford to run), distinct from the AI-4
   * `BehaviorProfile`'s selection (what this site wants to detect, and with what thresholds).
   */
  enabledBehaviors: z.array(z.string().min(1)).default([]),
  /** Relative analyzer costs, so degradation disables the most expensive first (refinement 4). */
  analyzerCosts: AnalyzerCostModel.optional(),
  /** Sampling stride override; when set it wins over `targetFps` for admission decisions. */
  samplingStride: z.number().int().min(1).max(600).optional(),
  /** Health scoring thresholds + weights (AI-5d). Absent = runtime defaults. */
  health: HealthPolicy.optional(),
  /**
   * Recovery budgets (AI-5d rec 4) — this is what makes "restart 3 times" (retail) and "never
   * restart without an operator" (healthcare) the same runtime with different configuration.
   */
  recovery: RecoveryPolicy.optional(),
  /** Model-transition strictness for this deployment (AI-5d rec 3). */
  modelLifecycle: ModelLifecyclePolicy.optional(),
});
export type DeploymentProfile = z.infer<typeof DeploymentProfile>;

// ---------------------------------------------------------------------------
// Pipeline definition — the staged execution shape (independently testable stages)
// ---------------------------------------------------------------------------

/**
 * The ordered pipeline stages the runtime executes for each frame:
 *   capture → preprocess → infer → postprocess → track → translate → publish.
 * `preprocess`/`infer` are the only engine-specific stages (behind the model adapter); the rest are
 * generic/model-independent. Each stage is independently replaceable and testable.
 */
export const PipelineStage = z.enum([
  'capture',
  'preprocess',
  'infer',
  'postprocess',
  'track',
  'translate',
  'publish',
]);
export type PipelineStage = z.infer<typeof PipelineStage>;

/** Describes one stage in a capability's pipeline (for discovery/observability). */
export const PipelineStageDescriptor = z.object({
  stage: PipelineStage,
  /** Whether this stage is engine-specific (behind the model-adapter seam) or generic. */
  engineSpecific: z.boolean().default(false),
  implementation: z.string().min(1).max(200).optional(),
});
export type PipelineStageDescriptor = z.infer<typeof PipelineStageDescriptor>;

/** The pipeline a capability runs, as an ordered list of stage descriptors. */
export const PipelineDefinition = z.object({
  capabilityId: CapabilityId,
  stages: z.array(PipelineStageDescriptor),
});
export type PipelineDefinition = z.infer<typeof PipelineDefinition>;
