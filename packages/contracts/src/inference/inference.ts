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
});
export type RuntimeMetrics = z.infer<typeof RuntimeMetrics>;

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
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type InferenceSession = z.infer<typeof InferenceSession>;

/** Input to start a session. */
export const StartInferenceSessionInput = z.object({
  cameraId: z.string().min(1),
  capabilityId: CapabilityId,
  modelId: z.string().min(1).optional(),
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
