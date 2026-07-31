/**
 * Behavior contracts (AI Processing Phase, AI-3) — the platform-owned **BehaviorResult** and its
 * immutable input view **TrackSnapshot**, as fundamental to behavioral intelligence as `Detection`
 * is to perception and `Track` is to identity.
 *
 * The whole point (Architect AI-3 direction): **optimize for the BehaviorResult contract, not for a
 * behavior algorithm.** A behavior may be produced by a temporal-window heuristic today and an ML or
 * LLM reasoner tomorrow — the rest of the platform must never know how. Any analyzer sits behind a
 * `BehaviorAnalyzer` seam, consumes an immutable `BehaviorContext`, and emits ONLY this
 * `BehaviorResult`, so swapping an analyzer's internals never touches downstream consumers.
 *
 * The perception → identity → behavior → platform chain (kept independent at every hop):
 *
 *     DetectionResult  →  Track  →  BehaviorResult  →  EventEnvelope
 *
 *   A **BehaviorResult** is NOT an event. It is a perception-tier statement ("this subject loitered",
 *   "this zone holds a queue of 5") with a lifecycle and confidence. A single `BehaviorResultTranslator`
 *   maps it to a canonical `EventEnvelope`; analyzers never emit envelopes (Architect AI-3 rec 11).
 *
 * Boundary (Architect AI-3 rec 12): thresholds an analyzer applies (dwell seconds, queue size,
 * confidence) are **detection sensitivity**, the same class as a confidence cutoff — legitimately in
 * the runtime. **Business interpretation** (after-hours, restricted personnel, escalation, emergency
 * mode) belongs exclusively to the Rule Engine. A BehaviorResult states *what was observed*, never
 * *what to do about it*.
 *
 * Grounds: docs/architecture/future/AI_EXECUTION_ARCHITECTURE.md, 05/08/09; ADR-0002/0012.
 */
import { z } from 'zod';
import { BBox, Confidence, IsoDateTime, SemVer, TenantId } from '../common/primitives.js';
import { Point2D, TrackState } from '../tracking/tracking.js';

/**
 * Behavior lifecycle (Architect AI-3 rec 2) — mirrors the discipline of `TrackState` so future
 * workflows can distinguish a behavior's start, continuation and completion. Semantics:
 *   detected — first frame the pattern was recognized (pre-confirmation)
 *   started  — the behavior is confirmed active (drives the first event)
 *   ongoing  — still active, no material change since last report
 *   updated  — still active, a tracked metric changed materially (e.g. queue length moved)
 *   ended    — the behavior stopped naturally (subject left, dwell reset)
 *   expired  — the behavior's subject/window aged out without a clean end (terminal, best-effort)
 */
export const BehaviorState = z.enum([
  'detected',
  'started',
  'ongoing',
  'updated',
  'ended',
  'expired',
]);
export type BehaviorState = z.infer<typeof BehaviorState>;

/**
 * Reusable behavior category (Architect AI-3 rec 5) — a coarse classification ORTHOGONAL to
 * `behaviorType`, for dashboard grouping / filtering / reporting. Business-neutral; the Rule Engine
 * still decides significance. Deliberately open-ended families, not a closed industry taxonomy.
 */
export const BehaviorCategory = z.enum([
  'security',
  'safety',
  'operational',
  'retail',
  'crowd',
  'compliance',
]);
export type BehaviorCategory = z.infer<typeof BehaviorCategory>;

/**
 * Reserved severity ladder (Architect AI-3 refinement 5). The AI runtime does NOT compute severity —
 * severity is business interpretation and belongs to the Rule Engine (or a future model). This enum +
 * the optional `BehaviorResult.severity` field exist only so populating it later never breaks the
 * contract. Left unset by all AI-3 analyzers.
 */
export const BehaviorSeverity = z.enum(['low', 'medium', 'high', 'critical']);
export type BehaviorSeverity = z.infer<typeof BehaviorSeverity>;

/**
 * Common analyzer configuration (Architect AI-3 refinement 2) — a single shared shape so every
 * analyzer is configured the same way and a future UI has one form to render. Analyzer-specific knobs
 * ride in `customParameters` (business-neutral numbers/flags), never as bespoke config schemas.
 * All fields optional with sensible omission → an analyzer supplies its own defaults.
 */
export const BehaviorConfig = z.object({
  /** Whether the analyzer participates in the pipeline (Registry gate). */
  enabled: z.boolean().default(true),
  /** Minimum confidence a produced BehaviorResult must reach to be emitted. */
  confidenceThreshold: Confidence.optional(),
  /** Suppression window (seconds) after emitting, to avoid event spam for the same subject. */
  cooldownSeconds: z.number().nonnegative().optional(),
  /** Temporal-window size (seconds) the analyzer reasons over, when time-based. */
  windowSeconds: z.number().nonnegative().optional(),
  /** Analyzer-specific numeric/flag knobs (e.g. `{ dwellSeconds: 10, minQueue: 3 }`). */
  customParameters: z
    .record(z.string(), z.union([z.number(), z.boolean(), z.string()]))
    .default({}),
});
export type BehaviorConfig = z.infer<typeof BehaviorConfig>;

/**
 * Per-analyzer runtime metrics (Architect AI-3 refinement 7) — a breakdown COMPLEMENTING the aggregate
 * behavior counters on `RuntimeMetrics`, so a slow or noisy analyzer is identifiable in production.
 * Business-neutral; keyed by analyzer name.
 */
export const BehaviorAnalyzerMetrics = z.object({
  analyzer: z.string().min(1),
  executionCount: z.number().int().nonnegative().default(0),
  averageExecutionTimeMs: z.number().nonnegative().default(0),
  lastExecutionTimeMs: z.number().nonnegative().default(0),
  averageConfidence: z.number().min(0).max(1).default(0),
  /** Behavior instances this analyzer has produced over the session. */
  behaviorsProduced: z.number().int().nonnegative().default(0),
});
export type BehaviorAnalyzerMetrics = z.infer<typeof BehaviorAnalyzerMetrics>;

/**
 * An **immutable** read-only view of a `Track` at one frame (Architect AI-3 rec 5). Analyzers receive
 * snapshots — never mutable `Track`s — so behavior analysis is deterministic and safe to parallelize.
 * A snapshot carries only what analyzers legitimately need (identity, position, state, quality hints).
 */
export const TrackSnapshot = z.object({
  trackId: z.string().min(1),
  tenantId: TenantId,
  cameraId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  label: z.string().min(1),
  state: TrackState,
  confidence: Confidence,
  bbox: BBox,
  centroid: Point2D.optional(),
  /** Frames since the track was created (for age-based behaviors without touching the mutable Track). */
  age: z.number().int().nonnegative(),
  hits: z.number().int().nonnegative(),
  frameIndex: z.number().int().nonnegative(),
  at: IsoDateTime,
  /** Tracker association confidence, if the producer supplied it (additive, not business logic). */
  trackingConfidence: Confidence.optional(),
});
export type TrackSnapshot = z.infer<typeof TrackSnapshot>;

/**
 * Reserved supporting-evidence metadata (Architect AI-4 rec 3) — an extension point so a behavior can
 * later reference what supports it. AI-4 populates only the naturally available fields
 * (`contributingTracks`/`contributingZones`); `supportingFrames`/`supportingDetections` stay reserved
 * for the dedicated Evidence-integration milestone. All optional — reserving now avoids a later
 * contract change. Never carries business meaning.
 */
export const BehaviorEvidence = z.object({
  contributingTracks: z.array(z.string().min(1)).optional(),
  contributingZones: z.array(z.string().min(1)).optional(),
  /** Reserved (deferred to the Evidence milestone). */
  supportingFrames: z.array(z.number().int().nonnegative()).optional(),
  /** Reserved (deferred to the Evidence milestone). */
  supportingDetections: z.array(z.string().min(1)).optional(),
});
export type BehaviorEvidence = z.infer<typeof BehaviorEvidence>;

/**
 * Composition metadata (Architect AI-4 rec 2) describing HOW a composite behavior was derived — for
 * debugging + replay, never business logic. Present only on composite results.
 */
export const CompositeMetadata = z.object({
  /** How many contributing BehaviorResults formed this composite. */
  contributingBehaviorCount: z.number().int().nonnegative(),
  /** The temporal window (seconds) the composite reasoned over, when time-based. */
  evaluationWindow: z.number().nonnegative().optional(),
  /** The evaluation rule applied (e.g. `all_of`, `sequence`, `any_of`). */
  evaluationStrategy: z.string().min(1).optional(),
  /** The composite analyzer's algorithm/config version (replay-stable). */
  compositionVersion: SemVer.optional(),
});
export type CompositeMetadata = z.infer<typeof CompositeMetadata>;

/**
 * A platform-owned statement that a behavior was observed — the SOLE output of every analyzer,
 * regardless of implementation (temporal window / heuristic / ML / LLM / hybrid). Distinct from
 * `EventEnvelope`: a `BehaviorResultTranslator` maps this to the wire event.
 */
export const BehaviorResult = z.object({
  /** Stable id for this behavior instance across its lifecycle (start → updated → ended). */
  behaviorId: z.string().min(1),
  /** Canonical behavior kind, e.g. `loitering`, `queue`, `intrusion`, `fire`. */
  behaviorType: z.string().min(1),
  /**
   * Analyzer algorithm version (Architect AI-3 refinement 1) — lets a behavior's logic evolve while
   * older replays remain interpretable. Optional; analyzers stamp their own version.
   */
  behaviorVersion: SemVer.optional(),
  /** Coarse grouping (Architect AI-3 rec 5). */
  category: BehaviorCategory,
  /**
   * Reserved business-severity (Architect AI-3 refinement 5) — NOT set by AI-3 analyzers; a future
   * Rule Engine / model may populate it. Optional so adding it later is non-breaking.
   */
  severity: BehaviorSeverity.optional(),
  /**
   * Optional correlation id (Architect AI-3 refinement 4) grouping multiple BehaviorResults produced
   * from the same track sequence — simplifies future investigation/evidence grouping. No workflow
   * logic attached here.
   */
  correlationId: z.string().min(1).optional(),
  tenantId: TenantId,
  cameraId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  /** The zone this behavior is scoped to, when spatial (loiter/queue/intrusion). */
  zoneId: z.string().min(1).optional(),
  /** The track identities involved (one for loiter/intrusion; many for queue/crowd). */
  subjects: z.array(z.string().min(1)).default([]),
  state: BehaviorState,
  confidence: Confidence,
  /**
   * Additive, business-neutral measurements (e.g. `{ dwellSeconds, queueLength, occupancy }`).
   * Numbers only — interpretation is the Rule Engine's.
   */
  metrics: z.record(z.string(), z.number()).default({}),
  /** When the behavior instance was first observed. */
  firstObserved: IsoDateTime,
  /** Most recent observation of this instance. */
  lastObserved: IsoDateTime,
  frameIndex: z.number().int().nonnegative(),
  /** The temporal window (ms) the analyzer reasoned over, when time-based. */
  windowMs: z.number().nonnegative().optional(),
  /** Which analyzer produced this (observability/provenance; not a business signal). */
  producer: z.string().min(1).optional(),
  /**
   * Behavior relationships (Architect AI-4 rec 2) — optional references to other BehaviorResults, so a
   * composite/correlation can be reconstructed without changing the core contract. No workflow logic.
   */
  parentBehaviorId: z.string().min(1).optional(),
  followsBehaviorId: z.string().min(1).optional(),
  relatedBehaviorIds: z.array(z.string().min(1)).optional(),
  /** Reserved supporting-evidence metadata (AI-4 rec 3). */
  evidence: BehaviorEvidence.optional(),
  /** Present only on composite results (AI-4 rec 1/2) — how this higher-order behavior was composed. */
  composite: CompositeMetadata.optional(),
  /** Generic extension seam (no industry semantics). */
  attributes: z.record(z.string(), z.unknown()).default({}),
});
export type BehaviorResult = z.infer<typeof BehaviorResult>;

/**
 * A **CompositeBehavior** (Architect AI-4 rec 1/12) — the fifth platform contract in the chain
 * `DetectionResult → Track → BehaviorResult → CompositeBehavior → EventEnvelope`. It IS a
 * `BehaviorResult` (so the whole downstream platform is unchanged) with `composite` metadata REQUIRED.
 * Produced by a composite analyzer that consumes only `BehaviorResult`s (never Tracks/Detections/zones)
 * and references its contributors via `relatedBehaviorIds` — preserving every layer's independence.
 * The composition engine is DOMAIN-NEUTRAL: retail/healthcare/etc. are configuration, not new types.
 */
export const CompositeBehavior = BehaviorResult.extend({
  composite: CompositeMetadata,
});
export type CompositeBehavior = z.infer<typeof CompositeBehavior>;

/**
 * A generic **zone role** (Architect AI-4 rec 4) — CONFIGURATION metadata a deployment attaches to a
 * `Zone` (via `attributes.role`) so profiles/composites can target zones by purpose. Analyzers never
 * depend on these names in code; the set is open (`z.string()` at the seam) and this enum only
 * documents common roles. Business meaning stays in the Rule Engine.
 */
export const ZoneRole = z.enum([
  'entrance',
  'exit',
  'checkout',
  'cash',
  'queue',
  'restricted',
  'storage',
  'loading',
  'aisle',
]);
export type ZoneRole = z.infer<typeof ZoneRole>;

/**
 * A declarative **behavior profile** (Architect AI-4 rec 3/9) — the deployment mechanism for every
 * industry. It configures GENERIC analyzers + composite rules for a deployment (retail/hospital/
 * warehouse/…) and carries NO workflow or business logic (that stays in the Rule Engine). Retail is
 * simply the first profile; a new customer onboards by authoring a profile, never new analyzer code.
 */
export const BehaviorProfile = z.object({
  profile: z.string().min(1),
  version: SemVer.default('1.0.0'),
  description: z.string().max(2000).optional(),
  /** Per-analyzer config overrides, keyed by analyzer name (generic analyzers only). */
  analyzers: z.record(z.string(), BehaviorConfig).default({}),
  /** Declarative composite rules (config, not code — Architect AI-4 rec 11). */
  composites: z
    .array(
      z.object({
        name: z.string().min(1),
        behaviorType: z.string().min(1),
        category: BehaviorCategory,
        /** Target event type from the catalog this composite maps to. */
        eventType: z.string().min(1),
        /** Behavior types that must all be present to compose (the `all_of` strategy). */
        requiredTypes: z.array(z.string().min(1)).min(1),
        /** Restrict to contributors in a zone carrying this role. */
        zoneRole: z.string().min(1).optional(),
        /** Require a contributor's `dwellSeconds` metric to reach this threshold. */
        minDwellSeconds: z.number().nonnegative().optional(),
        /** Grouping key for co-occurrence: `subject` (same track) or `zone`. */
        groupBy: z.enum(['subject', 'zone']).default('subject'),
        strategy: z.string().min(1).default('all_of'),
        /**
         * How the composite's confidence is derived from its contributors (Architect AI-4 refinement 2)
         * — replaceable without any downstream contract change.
         */
        confidenceStrategy: z.enum(['min', 'max', 'mean', 'weighted']).default('min'),
        version: SemVer.default('1.0.0'),
      }),
    )
    .default([]),
  /** Documentation map of logical zone name → role (the functional role rides on `Zone.attributes.role`). */
  zoneRoles: z.record(z.string(), z.string()).default({}),
  /** Reserved provenance (Architect AI-4 refinement 4) — profile evolution, no runtime effect. */
  createdAt: IsoDateTime.optional(),
  author: z.string().max(200).optional(),
});
export type BehaviorProfile = z.infer<typeof BehaviorProfile>;
