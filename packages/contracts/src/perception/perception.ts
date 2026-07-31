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
export const DetectionResult = z.object({
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
  /** Wall-clock inference time for the frame (ms). */
  inferenceMs: z.number().nonnegative(),
  /** Correlation id propagated from the frame (threads detections → events). */
  correlationId: z.string().min(1).optional(),
  at: IsoDateTime,
});
export type DetectionResult = z.infer<typeof DetectionResult>;
