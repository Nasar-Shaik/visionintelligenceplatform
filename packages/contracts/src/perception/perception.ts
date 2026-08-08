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
 * One subject's zone membership on one already-analysed frame (ADR-0053).
 *
 * ⚠️ Keyed by `identityId`, never `trackingId` — the accumulating primitives that read this group by
 * identity, and a membership attributed to a track id would split one person's dwell in two the first
 * time they walked behind a display (ADR-0038, ADR-0041).
 */
export const ZoneMembershipSubject = z.object({
  identityId: z.string().min(1).max(120),
  /** The zones this subject's floor-contact point was inside. Never empty — absence is absence. */
  zoneIds: z.array(z.string().min(1).max(120)).min(1).max(32),
});
export type ZoneMembershipSubject = z.infer<typeof ZoneMembershipSubject>;

/**
 * Zone membership carried back to the runtime for a frame it already answered (ADR-0053).
 *
 * ⛔ **`frameSeq` is load-bearing, not decoration.** With more than one request in flight per camera,
 * the echo raised for frame *N* may ride on the request for frame *N+2*; the runtime attaches it to
 * the history point with this sequence and counts a miss when there is none. Attaching it to
 * "whichever point is newest" would give one frame's zones to another — a wrong answer shaped exactly
 * like a right one.
 */
export const ZoneMembershipEcho = z.object({
  /** The frame these memberships describe — NOT the frame carrying them. */
  frameSeq: z.number().int().nonnegative(),
  /**
   * ⭐ **Which polygon set answered** — `AssignmentPlanEntry.zoneVersion`.
   *
   * Recorded with the membership so an archive can say *which* geometry produced it. That is what
   * makes storing membership safe (ADR-0053, amending ADR-0051): a polygon later found to be drawn
   * two metres off does not silently invalidate history, because history names the version it used
   * and re-resolving becomes a deliberate act with a visible version change.
   */
  zoneVersion: z.number().int().nonnegative().default(0),
  /**
   * ⛔ **May be empty, and empty is a real answer**: "for this frame, nobody was inside any zone".
   *
   * The echo is sent whenever the camera has zones at all, so its presence settles the whole frame.
   * Without that, "nobody was in a zone" and "the membership never arrived" are the same absence —
   * and a dwell computed over the second is a lower bound nobody labelled as one.
   *
   * Bounded: a frame with more simultaneous identities than this has a perception problem.
   */
  subjects: z.array(ZoneMembershipSubject).max(64),
});
export type ZoneMembershipEcho = z.infer<typeof ZoneMembershipEcho>;

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
  /**
   * ⭐ **Zone membership for a frame the runtime already answered** (ADR-0053, additive).
   *
   * A polygon test needs the boxes inference produces, so membership is necessarily resolved *after*
   * `/infer` returns — one hop too late for the behaviour primitives that read it. This field carries
   * it back on the **next** request, so the runtime can attach it to the track history it already
   * holds.
   *
   * ⚠️ **This is an observation, not configuration.** It carries `zoneId` strings the runtime itself
   * has no opinion about, never polygons — which is what keeps exactly one point-in-polygon engine in
   * the platform. See ADR-0053 for why a second one is the failure being avoided.
   *
   * ⚠️ Absent on the first frame of a stream, on any frame whose predecessor was dropped, and on
   * every deployment with no zones drawn.
   */
  zoneMembership: ZoneMembershipEcho.optional(),
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
 *
 * `1.2` adds `scene` (ADR-0054) — the first statement this contract can make about a frame rather
 * than about a rectangle in it.
 */
export const DETECTION_RESULT_SCHEMA_VERSION = '1.2';

/**
 * ⭐ **A statement about the frame, not about a rectangle in it** (ADR-0054, additive).
 *
 * The runtime's `FrameLabel` on the wire. "Six identities present", "an object changed hands at
 * 41.2 s" and "the queue is six long" are all facts no per-detection record can hold, and a frame
 * with **no** detections can still carry one — occupancy 0 is a fact.
 *
 * ⛔ **`kind` is domain-neutral, by the same test as every Layer 2 primitive** (ADR-0052): a
 * hospital, a warehouse and a school must all be able to use it under their own name. `occupancy`,
 * `density`, `queueLength` and `handover` pass; `shoplifting` does not, and naming an intent here
 * would put Layer 3 inside the perception contract.
 */
export const SceneObservation = z.object({
  /** What is being stated, e.g. `occupancy` | `handover`. Open vocabulary, closed semantics. */
  kind: z.string().min(1).max(64),
  confidence: Confidence.default(1),
  /** The statement's own fields, e.g. `{ zoneId, count }`. Generic; no industry semantics. */
  attributes: z.record(z.string(), z.unknown()).default({}),
  /**
   * Frame numbers this statement spans, inclusive. Absent means "this frame only".
   *
   * ⚠️ Frames, not seconds — the span is a property of the observation window, and footage seconds
   * belong in `attributes` where their unit can be named.
   */
  span: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
});
export type SceneObservation = z.infer<typeof SceneObservation>;

/**
 * How many scene observations one frame may carry.
 *
 * ⚠️ Bounded because this rides a frozen contract onto a broker. One occupancy statement per zone
 * plus a handful of events is single digits in practice; the cap exists so a stage bug becomes a
 * truncated document rather than an unbounded publish.
 */
export const MAX_SCENE_OBSERVATIONS = 64;

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
   * ⭐ **Frame-level facts** (ADR-0054, additive, schema 1.2). See {@link SceneObservation}.
   *
   * ⚠️ Optional and absent — never `[]` — when nothing was said. An empty array and a missing key
   * would be a third state meaning the same thing, which is how two consumers come to disagree about
   * what "no scene observations" looks like (the same rule `zoneIds` follows in the zone resolver).
   */
  scene: z.array(SceneObservation).max(MAX_SCENE_OBSERVATIONS).optional(),
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
  /**
   * ⭐ **The offline analysis run this result belongs to** (ADR-0047, additive).
   *
   * ⚠️ **Stamped by the media service, never by the AI runtime.** AI Runtime v1.0 is frozen and
   * closed; it neither knows nor needs to know that offline analysis exists. Media holds the frame's
   * provenance, so media is the only thing that can say this truthfully — and it attaches it on the
   * way to the broker, after the runtime has answered.
   *
   * ⚠️ Absent for every live camera frame, which is what keeps live behaviour unchanged. It is
   * deliberately **not** `correlationId`: that is stamped per frame on the live path, so it cannot
   * carry a run identity. See `EventEnvelope.analysisSessionId`.
   */
  analysisSessionId: z.string().min(1).max(120).optional(),
  at: IsoDateTime,
});
export type DetectionResult = z.infer<typeof DetectionResult>;
