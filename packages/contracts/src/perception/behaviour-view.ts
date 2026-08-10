/**
 * **The three behaviour projections, as a reader receives them** (Phase 2.4 slice 2.8).
 *
 *     track history  ──▶  timeline  ──▶  graph        one computation, three shapes
 *                     └─▶  primitives                 the same facts, per identity
 *
 * ### ⛔ Why these are contracts and not `unknown`
 *
 * The console renders investigation evidence. Every field below is a number an operator will read as
 * a fact about a named person — a dwell, a proximity, a frame to seek to — and a browser that parses
 * a payload by hand cannot tell "the runtime changed shape" from "nothing happened". Both render as
 * an empty panel. The types exist so the *disagreement* is loud.
 *
 * ⚠️ **These describe a READ, not a stored record.** Nothing here is persisted: the projections are
 * pure functions over the movement paths ADR-0051 made durable, recomputed on every request
 * (ADR-0054). A corrected formula therefore fixes history rather than being unable to reach it — and
 * a consumer must not cache one of these as though it were the archive.
 *
 * ### ⛔ Two clocks, and the offset is the derived one
 *
 * `atSeconds` on a timeline entry is an offset from the run's **first observation**, which is not the
 * start of the recording — nobody is necessarily in shot at 00:00. `footageSeconds` beside it is the
 * absolute footage clock, and it is the only value that joins to a history point, an event or a video
 * position. `behaviourOffsetInRecording` in the console does that arithmetic exactly once.
 */
import { z } from 'zod';
import { BBox } from '../common/primitives.js';

/**
 * Every kind of fact a timeline entry may be.
 *
 * ⛔ **Closed, and it must equal `behaviour_timeline.TIMELINE_KINDS`.** A viewer that meets an
 * unknown kind in production renders it as a blank row, which reads as "nothing happened here". The
 * runtime publishes the list on every timeline response (`kinds`) so a consumer can check rather than
 * assume, and `tools/contracts/verify-schemas.mjs` asserts the two lists agree at build time.
 */
export const BehaviourTimelineKind = z.enum([
  'observed',
  'gap',
  'zoneVisit',
  'zoneEntry',
  'zoneExit',
  'proximity',
  'carried',
  'handover',
  'idle',
  'linger',
  'lineCross',
  'follow',
  'approach',
  'recede',
  'groupMerge',
  'groupSplit',
  'queue',
  'picked',
  'dropped',
  'objectMissing',
  'objectReturned',
]);
export type BehaviourTimelineKind = z.infer<typeof BehaviourTimelineKind>;

/**
 * Where to look. ⛔ **A fact with no evidence is an assertion**, and the whole of this milestone is
 * the refusal to ship those — so `frameIndex` is what makes a row clickable back to a video frame.
 *
 * ⚠️ `trackId`, not the identity: the identity is the row's subject, and an investigator seeking a
 * frame needs the observation that produced it.
 */
export const BehaviourEvidence = z.object({
  frameIndex: z.number().int().optional(),
  trackId: z.string().optional(),
});
export type BehaviourEvidence = z.infer<typeof BehaviourEvidence>;

/** One fact about one identity, over one interval, with the frame it came from. */
export const BehaviourTimelineEntry = z.object({
  /** ⚠️ Not narrowed to the enum: an unrecognised kind must arrive and be *reported*, not rejected. */
  kind: z.string().min(1),
  identityId: z.string().min(1),
  /** ⛔ Offset from the run's FIRST OBSERVATION — see the module note on the two clocks. */
  atSeconds: z.number(),
  endSeconds: z.number().optional(),
  /** Length of the interval. Absent on an instant. */
  seconds: z.number().optional(),
  /** ⭐ The absolute footage second. The only value that joins to anything outside this response. */
  footageSeconds: z.number(),
  cameraId: z.string(),
  streamId: z.string().optional(),
  /** A sentence an operator reads. ⚠️ States the measurement, never a motive (ADR-0052). */
  summary: z.string(),
  attributes: z.record(z.string(), z.unknown()).default({}),
  evidence: BehaviourEvidence.default({}),
});
export type BehaviourTimelineEntry = z.infer<typeof BehaviourTimelineEntry>;

/**
 * ⛔ **How much of the scene the pairwise families actually looked at.**
 *
 * Past `maxIdentities` the proximity, follow, approach and grouping families never ran, so the answer
 * is *complete-looking* and simply has no `near`, `followed` or group in it. That is worse than a
 * short list, and it is the reason this rides on every projection rather than being inferred.
 */
export const BehaviourRelationalCoverage = z.object({
  identitiesConsidered: z.number().int().min(0),
  truncated: z.boolean(),
  maxIdentities: z.number().int().min(0),
});
export type BehaviourRelationalCoverage = z.infer<typeof BehaviourRelationalCoverage>;

/**
 * ⛔ **The state of one evidence read — six values, and every one is a different fact** (EI-4).
 *
 * Measured before this existed: all five of these were the same empty list.
 *
 *     a stream that never existed        →  []
 *     a run still three seconds in       →  []
 *     a run whose durable write failed   →  []
 *     a file with a truncated record     →  []
 *     a run past its retention           →  []
 *
 * An investigator reading an empty timeline concludes *nothing happened*, which is right in exactly
 * one of those five and catastrophically wrong in three.
 *
 * ⚠️ The three rules the platform holds itself to, structurally rather than by memory:
 * **corrupted never appears as missing**, **lost is never reported as absent**, and **expired is
 * never reported as lost** — an expiry is a promise kept, and dressing a defect as one is the most
 * comfortable lie available here.
 */
export const EvidenceState = z.enum([
  /** The evidence is here and closed. */
  'present',
  /** ⚠️ The run is still producing it — every duration below is a lower bound, not a result. */
  'notYetAvailable',
  /** There is none, and none was lost. Nothing happened. */
  'absent',
  /** ⛔ It existed and the platform failed to keep it. Never renders as `absent`. */
  'lost',
  /** ⛔ It is on disk and cannot be read. Never renders as `absent`. */
  'corrupted',
  /** Retention removed it, as promised. ⚠️ A kept promise, never a defect. */
  'expired',
]);
export type EvidenceState = z.infer<typeof EvidenceState>;

export const EvidenceRead = z.object({
  state: EvidenceState,
  /** ⚠️ Operator-facing. Says what it means for the answer, not what the code did. */
  detail: z.string().min(1).max(600),
  durable: z.number().int().min(0),
  live: z.number().int().min(0),
  records: z.number().int().min(0),
  /** Records on disk this read could not parse. ⛔ Non-zero means the answer is incomplete. */
  damagedRecords: z.number().int().min(0),
  /** ⛔ *Which* identities were lost. A count is a status line; a name is something to act on. */
  lostIdentities: z.array(z.string()).max(64).optional(),
  /**
   * The instant before which retention guarantees nothing survives.
   *
   * ⭐ Published so the caller holding a run's `finishedAt` can resolve `absent` into `expired` —
   * a proof rather than an inference, and made in the one place both facts exist.
   */
  retentionHorizonAt: z.string().optional(),
});
export type EvidenceRead = z.infer<typeof EvidenceRead>;

/**
 * ⚠️ Whether the runtime could answer at all, echoed back with what was asked.
 *
 * `enabled: false` means this deployment stores no track history — a different answer from "this
 * stream has no behaviour in it", and they render identically without this field.
 */
export const BehaviourReadEnvelope = z.object({
  enabled: z.boolean(),
  detail: z.string().optional(),
  /** ⚠️ Echoed. A caller who mistyped a stream id gets an empty answer either way; only this says which. */
  query: z
    .object({
      cameraId: z.string().nullable().optional(),
      streamId: z.string().nullable().optional(),
      identityId: z.string().nullable().optional(),
    })
    .optional(),
  /** ⭐ `durable` vs `live`: a finished analysis and one 3 % through look the same as a record count. */
  sources: z.record(z.string(), z.unknown()).optional(),
  /** ⛔ Six-valued, never collapsed — see `EvidenceState`. */
  evidence: EvidenceRead.optional(),
  /** ⛔ See `BehaviourPrimitives.lineGeometry` — four states, and `invalid` is never `absent`. */
  lineGeometry: z.enum(['present', 'none', 'absent', 'invalid']).optional(),
  /**
   * ⭐ The line zones this read was evaluated against, echoed back (slice 2.9).
   *
   * ⚠️ Echoed for the same reason `query` is: a crossing that did not appear because the wrong line
   * was in force, and one that did not appear because nobody crossed, are indistinguishable without
   * knowing which lines were examined.
   */
  lines: z.array(z.object({ lineId: z.string(), name: z.string().optional() })).default([]),
});

export const BehaviourTimelineView = BehaviourReadEnvelope.extend({
  entries: z.array(BehaviourTimelineEntry).default([]),
  /** ⛔ `true` ⇒ more facts of the requested kinds existed than the cap, so the tail was cut. */
  truncated: z.boolean().default(false),
  relational: BehaviourRelationalCoverage.optional(),
  /** The closed vocabulary, published so a viewer renders every kind rather than meeting one. */
  kinds: z.array(z.string()).default([]),
  /**
   * ⭐ **Every kind this run produced, counted before the filter and before the cap.**
   *
   * ⛔ The number that says what a short list left out. On a live camera **1207 of the 2000 entries
   * the cap allowed were `gap`** — so every merge, queue and crossing later in the run had been cut
   * to make room for facts about nobody being there, and the list looked complete. Asking for
   * `kinds` narrows the answer *in the runtime*, which is the only place the loss can be avoided.
   */
  countsByKind: z.record(z.string(), z.number().int().min(0)).default({}),
  /** The kinds asked for; empty means everything. ⚠️ Echoed, so a mistyped kind is visible. */
  kindsRequested: z.array(z.string()).default([]),
  /** How many facts the filter removed. ⚠️ A short list must never read as a quiet run. */
  excludedByKind: z.number().int().min(0).default(0),
});
export type BehaviourTimelineView = z.infer<typeof BehaviourTimelineView>;

// ---------------------------------------------------------------------------------------------
// the graph
// ---------------------------------------------------------------------------------------------

/** `identity` · `object` · `zone` · `group` · `line`. ⚠️ Open, for the same reason `kind` above is. */
export const BehaviourNodeKind = z.enum(['identity', 'object', 'zone', 'group', 'line']);
export type BehaviourNodeKind = z.infer<typeof BehaviourNodeKind>;

export const BehaviourGraphNode = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  label: z.string(),
  /**
   * ⭐ Node attributes carry the facts a subject established **alone** — `idle`, `linger`, `gap`.
   * They are not self-edges: an edge from a node to itself is a drawing problem in every renderer
   * and a lie in every traversal.
   */
  attributes: z.record(z.string(), z.unknown()).default({}),
});
export type BehaviourGraphNode = z.infer<typeof BehaviourGraphNode>;

export const BehaviourGraphEdge = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  /** ⛔ ABSOLUTE footage seconds — unreadable without `originSeconds`. See `BehaviourGraphView`. */
  atSeconds: z.number(),
  endSeconds: z.number().optional(),
  seconds: z.number().optional(),
  attributes: z.record(z.string(), z.unknown()).default({}),
  evidence: BehaviourEvidence.default({}),
});
export type BehaviourGraphEdge = z.infer<typeof BehaviourGraphEdge>;

export const BehaviourGraph = z.object({
  nodes: z.array(BehaviourGraphNode).default([]),
  edges: z.array(BehaviourGraphEdge).default([]),
  counts: z
    .object({
      nodes: z.number().int().min(0),
      edges: z.number().int().min(0),
      byNodeKind: z.record(z.string(), z.number()).default({}),
      byEdgeKind: z.record(z.string(), z.number()).default({}),
    })
    .optional(),
  /**
   * ⛔ Footage second of the run's first observation, and every `atSeconds` above is measured from
   * the epoch rather than from this. A consumer that renders an edge time directly says a subject
   * "was inside the zone at 1786221387.294 s" — true, useless, and a defect this platform has now
   * shipped twice at two different layers.
   */
  originSeconds: z.number().default(0),
  truncated: z
    .object({
      nodes: z.boolean(),
      edges: z.boolean(),
      relational: z.boolean(),
      identitiesConsidered: z.number().int().min(0),
      maxIdentities: z.number().int().min(0).optional(),
    })
    .optional(),
});
export type BehaviourGraph = z.infer<typeof BehaviourGraph>;

export const BehaviourGraphView = BehaviourReadEnvelope.extend({
  graph: BehaviourGraph.optional(),
});
export type BehaviourGraphView = z.infer<typeof BehaviourGraphView>;

// ---------------------------------------------------------------------------------------------
// the primitives
// ---------------------------------------------------------------------------------------------

/**
 * ⭐ **The thresholds every business word was computed at, published with the answer.**
 *
 * "Lingered" is a claim about a person, and it means `stationary within 0.08 of the frame width for
 * at least 15 s` and nothing else. An operator reading the word and a rule author choosing a dwell
 * limit are looking at the same numbers, and neither has to read the source to find them.
 */
export const BehaviourReading = z.object({
  mechanism: z.string().optional(),
  means: z.string().optional(),
  radiusNormalized: z.number().optional(),
  minSeconds: z.number().optional(),
  thresholdNormalized: z.number().optional(),
  minSize: z.number().optional(),
  maxDistanceNormalized: z.number().optional(),
  headingToleranceDegrees: z.number().optional(),
  minSpeedNormalizedPerSecond: z.number().optional(),
  minChangeNormalized: z.number().optional(),
  /** ⚠️ Relative to the run's own sampling rate — see `gap` in `PRIMITIVE_READINGS`. */
  expectedIntervalFactor: z.number().optional(),
});
export type BehaviourReading = z.infer<typeof BehaviourReading>;

export const BehaviourPrimitives = z.object({
  task: z.string().optional(),
  modules: z.array(z.string()).default([]),
  /** identityId → the attributes every module stamped onto that subject. */
  identities: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  scene: z.array(z.record(z.string(), z.unknown())).default([]),
  /**
   * ⛔ Three-valued. `absent` says the zone primitives were **inert** because nothing ever supplied
   * membership — a different answer from "nobody entered a zone", and the two are indistinguishable
   * on screen unless one of them is spelled out.
   */
  zoneMembership: z.enum(['present', 'absent']).optional(),
  /**
   * ⛔ **Four-valued, and every value is a different fact** (slice 2.9).
   *
   * - `present` — geometry arrived and crossings were evaluated against it.
   * - `none`    — the camera has no line zones, so "nobody crossed a line" is a *complete* answer.
   * - `absent`  — no geometry reached this read; nothing here says anything about crossings.
   * - `invalid` — geometry arrived and could not be read. ⛔ **Never folded into `absent`**: a
   *   malformed line is a configuration fault a person must fix, and all four states render
   *   identically downstream as "no crossings". Three of them are fine; one means the platform is
   *   quietly broken, and it stays broken for as long as nobody is told.
   */
  lineGeometry: z.enum(['present', 'none', 'absent', 'invalid']).optional(),
  observedIntervalSeconds: z.number().optional(),
  /**
   * ⭐ **Why a line reported what it reported** (slice 2.9).
   *
   * ⛔ A correctly-drawn tripwire and a badly-drawn one both report nothing. Measured on the
   * deployment: a vertical line from y = 0.05 to y = 0.95 — visually spanning the frame — caught a
   * person walking straight across it **zero** times, because membership is anchored at the foot
   * point and a standing person's feet sit at y ≈ 0.95. The walk passed *around the bottom end* of
   * the drawn segment, and the geometry correctly refused it.
   *
   * `sideChanges > 0` with `crossings === 0` is that situation, named: people are walking *past*
   * this line rather than *through* it. ⚠️ A diagnostic, never an event — a missed side change is
   * not reported as a crossing, and the fix is to draw the line correctly.
   */
  lineDiagnostics: z
    .array(
      z.object({
        lineId: z.string(),
        sideChanges: z.number().int().min(0),
        crossings: z.number().int().min(0),
        missedTheSegment: z.number().int().min(0),
      }),
    )
    .default([]),
  /**
   * ⭐ **Why the association layer reported what it reported** (slice 2.10).
   *
   * ⛔ `AssociationModule` ran on every frame for three milestones and never once had an object to
   * associate — and every read looked exactly like a scene where nobody carried anything. Four
   * different situations render identically as "no association":
   *
   * - nobody carried anything — *the product working*;
   * - the detector never returned a carriable class at all — the truth for three milestones, whose
   *   cause was a single confidence floor chosen for `person` and applied to eighty classes;
   * - objects and people were seen, never in the same frame — a timestamp join failing;
   * - they were in the same frame and never close enough — a real measurement about the scene.
   *
   * `reason` names which. ⚠️ Absent when a span was produced, so the *presence* of a reason is
   * itself the signal. `closestNormalized` is omitted rather than zeroed when nothing was ever
   * observed together — `0.0` is the one value that means "touching" (ADR-0039).
   */
  associationDiagnostic: z
    .object({
      subjects: z.number().int().min(0),
      objects: z.number().int().min(0),
      objectLabels: z.array(z.string()).default([]),
      /**
       * ⛔ Tracked objects excluded because nobody carries one, and their labels.
       *
       * On the first real multi-class run the association layer's input was
       * `["backpack", "car", "suitcase"]` — "object" had meant *any non-subject label* since slice
       * 2.2, so a **parked car** sat one proximity away from *"this person carried a car"*. ⚠️ It
       * never produced that span; only the geometry prevented it. Narrowing `carried` to things a
       * person can pick up removes the possibility, and this field keeps the narrowing from
       * creating a second silence in which "nothing detected" and "a car detected" look alike.
       */
      notCarriable: z.number().int().min(0).default(0),
      notCarriableLabels: z.array(z.string()).default([]),
      framesTogether: z.number().int().min(0),
      unjoinedObjectPoints: z.number().int().min(0),
      pairsNear: z.number().int().min(0),
      thresholdNormalized: z.number(),
      spans: z.number().int().min(0),
      closestNormalized: z.number().optional(),
      reason: z
        .enum([
          'no-objects-detected',
          'no-carriable-objects',
          'no-subjects-detected',
          'never-observed-together',
          'never-close-enough',
          'no-span-formed',
        ])
        .optional(),
    })
    .optional(),
  readings: z.record(z.string(), BehaviourReading).default({}),
  relational: BehaviourRelationalCoverage.optional(),
  /** ⚠️ A module that threw is named here rather than silently contributing nothing. */
  moduleFailures: z.record(z.string(), z.string()).default({}),
});
export type BehaviourPrimitives = z.infer<typeof BehaviourPrimitives>;

export const BehaviourPrimitivesView = BehaviourReadEnvelope.extend({
  primitives: BehaviourPrimitives.optional(),
});
export type BehaviourPrimitivesView = z.infer<typeof BehaviourPrimitivesView>;

// ---------------------------------------------------------------------------------------------
// track history — the movement paths every projection above is derived from
// ---------------------------------------------------------------------------------------------

/**
 * One observation of one identity in one frame (ADR-0051).
 *
 * ⭐ `confidence` here is the **detector's** score for that observation, and it is the only
 * confidence this platform has for a behaviour fact. A primitive is a geometric measurement against
 * a published threshold — it met the threshold or it did not — so there is no probability to attach
 * to "lingered", and inventing one would be read as a likelihood the platform cannot support.
 */
export const TrackHistoryPointView = z.object({
  frameIndex: z.number().int(),
  at: z.string(),
  bbox: BBox,
  trackId: z.string(),
  label: z.string().default('person'),
  confidence: z.number().min(0).max(1).default(1),
  /**
   * ⛔ **Optional, and its ABSENCE is the encoding of "membership was never decided."**
   *
   * ⚠️ Not `zonesSettled: false` — the runtime does not send that field at all. `HistoryPoint.to_dict`
   * omits `zoneIds` entirely when membership is unsettled and emits `[]` when something decided the
   * answer was "inside none", because absence is the only encoding a reader cannot mistake for
   * "outside every zone". A consumer that looked for a boolean would find `undefined`, read it as
   * falsy, and report every observation as undecided **on a deployment where zones work perfectly**
   * — a confident wrong number, which is worse than none. Found on the deployment, slice 2.8.
   */
  zoneIds: z.array(z.string()).optional(),
});
export type TrackHistoryPointView = z.infer<typeof TrackHistoryPointView>;

export const TrackHistoryRecordView = z.object({
  schemaVersion: z.string().optional(),
  identityId: z.string().min(1),
  tenantId: z.string(),
  cameraId: z.string(),
  streamId: z.string().optional(),
  label: z.string().default('person'),
  points: z.array(TrackHistoryPointView).default([]),
  /** ⭐ More than one ⇒ a gap was bridged, and an investigator can see exactly where. */
  trackIds: z.array(z.string()).default([]),
  closed: z.boolean().default(false),
  writtenAt: z.string().optional(),
  /** ⭐ Which polygon *version* decided this record's membership (ADR-0053). */
  zoneVersion: z.number().int().optional(),
});
export type TrackHistoryRecordView = z.infer<typeof TrackHistoryRecordView>;

export const TrackHistoryView = z.object({
  enabled: z.boolean(),
  detail: z.string().optional(),
  unreachable: z.boolean().optional(),
  records: z.array(TrackHistoryRecordView).default([]),
  live: z.array(TrackHistoryRecordView).default([]),
  stats: z.record(z.string(), z.unknown()).optional(),
});
export type TrackHistoryView = z.infer<typeof TrackHistoryView>;
