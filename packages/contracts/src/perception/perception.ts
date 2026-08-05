/**
 * Perception / inference contracts (Phase 1, P1-6). The model-agnostic capability runtime consumes
 * a frame + tenant context and emits normalized detections (class + confidence + bbox) — never a
 * model-specific shape. These are the outputs the event pipeline (P1-5) turns into `perception.*`
 * events. Grounds: docs/architecture/05-CAPABILITY-ARCHITECTURE.md, 08-AI-ML-PLATFORM.md,
 * docs/architecture/phase1/AI_PIPELINE.md; ADR-0002 (model-agnostic), ADR-0012 (adapter layer).
 *
 * FROZEN — AI Runtime Architecture v1.0 (ED-0039): `DetectionResult` is one of the five frozen AI
 * contracts. Evolve ADDITIVELY only (optional fields); breaking changes require an ADR + major bump.
 */
import { z } from 'zod';
import {
  BBox,
  CapabilityId,
  Confidence,
  IsoDateTime,
  SemVer,
  TenantId,
} from '../common/primitives.js';
import { TenantContext } from '../common/tenant-context.js';
import { ModelSelector } from '../capability/descriptor.js';

/**
 * A single normalized detection — deliberately **model-independent** (no YOLO/vendor specifics), so
 * the same contract carries detection, recognition, re-ID, and future capability outputs. `label`
 * is a generic class name (e.g. "person"); `bbox` is `[x, y, w, h]` in normalized [0,1] image
 * coordinates (BBox). `attributes`/`metadata` are open generic maps; `embedding`/`trackingId` are
 * optional (re-ID + tracking). Extend additively (Constitution §7).
 */
export const Detection = z.object({
  /**
   * Stable identity for one detection (P-8 Phase 3, additive).
   *
   * ⚠️ **Derived, not random.** It is a digest of tenant + camera + capture time + frame sequence +
   * index, so re-running the same frame through the same model yields the same id. On a platform
   * whose output becomes evidence, "we reprocessed and got different identifiers" is a question
   * nobody should have to answer.
   */
  detectionId: z.string().min(1).optional(),
  label: z.string().min(1),
  /** Optional numeric class id from the model's label space (informational). */
  classId: z.number().int().nonnegative().optional(),
  confidence: Confidence,
  bbox: BBox,
  /** Generic, capability-defined attributes (e.g. `{ color: "red" }`). No industry semantics. */
  attributes: z.record(z.string(), z.unknown()).default({}),
  /** Optional feature vector for re-ID / similarity search (per-tenant namespaces later). */
  embedding: z.array(z.number()).optional(),
  /** Free-form provenance/debug metadata. */
  metadata: z.record(z.string(), z.unknown()).default({}),
  /** Optional stable track id across frames (assigned by the tracking stage). */
  trackingId: z.string().min(1).optional(),
  /**
   * Identity across gaps the tracker bridged (P-8 Phase 5, additive — ADR-0041).
   *
   * ⚠️ **`trackingId` and `identityId` answer different questions, and a consumer that picks the
   * wrong one fails SILENTLY.** `trackingId` is one uninterrupted observation; a person briefly
   * occluded comes back with a NEW one, because ADR-0038 forbids reusing an id. `identityId` is the
   * first track in that chain — so anything ACCUMULATING over time (dwell, loitering, occupancy)
   * must group by `identityId`, or a person hidden for two seconds becomes two short visits and a
   * sixty-second threshold is never crossed. No error, no alert, and it depends on host load.
   *
   * ⚠️ Advisory, not proof. Re-entry linking is geometric — position, size, elapsed time, class —
   * with no appearance model, so it can link the wrong person ([L-42]). Equal to `trackingId` for a
   * first appearance, so a consumer never has to special-case its absence.
   */
  identityId: z.string().min(1).optional(),
  /** The immediate predecessor in the identity chain, when this detection's track re-entered. */
  precededBy: z.string().min(1).optional(),
});
export type Detection = z.infer<typeof Detection>;

/**
 * Reference to the input frame — the wire form of the runtime's `FrameContext`. It carries the full
 * request context (camera/stream/timing) so every capability, event, and log can be correlated
 * without re-plumbing later (multi-camera, multi-tenant, analytics). Pixels travel inline (base64)
 * in Phase 1.
 */
export const FrameRef = z.object({
  cameraId: z.string().min(1),
  /** The stream/session this frame belongs to (defaults to the camera when 1:1). */
  streamId: z.string().min(1).optional(),
  /** Optional org-hierarchy node the camera sits under (P1-1 `OrgNode`). */
  organizationId: z.string().min(1).optional(),
  /** Monotonic frame sequence within a stream. */
  seq: z.number().int().nonnegative(),
  capturedAt: IsoDateTime,
  fps: z.number().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** Pixel encoding of the inline image, e.g. "image/jpeg". */
  format: z.string().optional(),
  /** Where the frame came from, e.g. "rtsp" | "snapshot" | "upload". */
  source: z.string().optional(),
  /** Correlation id threading the frame → detections → events → incident chain. */
  correlationId: z.string().min(1).optional(),
});
export type FrameRef = z.infer<typeof FrameRef>;

/**
 * A request to run a capability over one frame. The tenant context and the frame travel TOGETHER —
 * a frame without context is dropped fail-closed (AI_PIPELINE §Security). The image is inline as
 * base64 (Phase 1, batch=1); a shared-memory/handle transport is a later optimization.
 */
export const InferenceRequest = z.object({
  context: TenantContext,
  frame: FrameRef,
  /** Which capability to run; defaults to the service's bound capability when omitted. */
  capabilityId: CapabilityId.optional(),
  /** Optional per-request model selector override (else the descriptor's selector is used). */
  selector: ModelSelector.optional(),
  /** Base64-encoded frame bytes (e.g. a JPEG). */
  imageBase64: z.string().min(1),
});
export type InferenceRequest = z.infer<typeof InferenceRequest>;

/** The concrete model the capability resolved by selector (returned for provenance/observability). */
export const ModelBinding = z.object({
  /** Registered model id in the runtime's catalogue, e.g. "yolox-nano" (P-8 Phase 3, additive). */
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  version: z.string().min(1),
  task: z.string().min(1),
  family: z.string().default('*'),
  accelerator: z.enum(['gpu', 'cpu']).default('cpu'),
});
export type ModelBinding = z.infer<typeof ModelBinding>;

/**
 * The normalized inference result — tenant-tagged, model-provenanced, with zero or more detections.
 * The capability persists no tenant data; this result is what flows onward as events (P1-5). It
 * carries full **version metadata** (runtime + capability + model + execution provider + timestamp)
 * so every result is auditable, reproducible, and rollback-diagnosable.
 */
/**
 * The version of the `DetectionResult` shape itself (P-8 Phase 3).
 *
 * ⚠️ Distinct from `runtimeVersion` (which process produced it), `capabilityVersion` (which
 * capability) and the model's version (which weights). This one answers **"how do I read this
 * document?"** — the question a consumer three years from now, holding an archived result, cannot
 * answer from any of the others.
 *
 * `1.1` because the frozen v1.0 contract gained optional fields in P-8 Phase 3 (`detectionId`,
 * `frameLatencyMs`, `model.id`, `schemaVersion`). Additive only; a breaking change needs an ADR and
 * a major bump (ED-0039).
 */
export const DETECTION_RESULT_SCHEMA_VERSION = '1.1';

export const DetectionResult = z.object({
  /**
   * How to read this document. Optional so archived v1.0 results stay valid; the runtime always
   * stamps it. See {@link DETECTION_RESULT_SCHEMA_VERSION}.
   */
  schemaVersion: z.string().min(1).optional(),
  tenantId: TenantId,
  cameraId: z.string().min(1),
  capabilityId: CapabilityId,
  capabilityVersion: SemVer,
  runtimeVersion: z.string().min(1),
  /** The backend that produced the result, e.g. "stub" | "CPUExecutionProvider". */
  executionProvider: z.string().min(1),
  model: ModelBinding,
  frame: z.object({ seq: z.number().int().nonnegative(), capturedAt: IsoDateTime }),
  detections: z.array(Detection).default([]),
  /**
   * How the frame was turned into a tensor, as a reproducible fingerprint — implementation version
   * plus the resolved input spec, e.g. `1.0/letterbox-416x416-NCHW-float32-BGR-pad114`.
   *
   * ⚠️ Without this a result is **not** reproducible: identical model, identical provider and
   * identical frame give different detections if the resize policy, colour order or pad value
   * changed, and none of the other version fields would show it.
   */
  preprocessingVersion: z.string().min(1).optional(),
  /** The confidence floor applied when this result was produced (the capability's setting). */
  confidenceThreshold: Confidence.optional(),
  /** Wall-clock inference time for the frame (ms). */
  inferenceMs: z.number().nonnegative(),
  /**
   * Age of the frame when the result was produced — capture → detection, in ms (P-8 Phase 3,
   * additive). ⚠️ A different question from `inferenceMs`, and the one an operator actually asks:
   * inference can be fast while the answer is old because the frame queued. Absent when the frame
   * carried no usable `capturedAt`, because a fabricated zero would read as "instant".
   */
  frameLatencyMs: z.number().nonnegative().optional(),
  /** Correlation id propagated from the frame (threads detections → events). */
  correlationId: z.string().min(1).optional(),
  at: IsoDateTime,
});
export type DetectionResult = z.infer<typeof DetectionResult>;
