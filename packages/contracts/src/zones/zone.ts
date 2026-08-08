/**
 * **Detection zones** (P-8 Phase 7 §Zones) — the reusable spatial assets a rule points at.
 *
 * A detection zone is a named polygon drawn on **one camera's image plane**, in normalised `[0,1]`
 * coordinates, and it answers exactly one question: *is this subject inside it?* Nothing here knows
 * what the zone means. "Entrance", "checkout queue", "restricted store room" are names an operator
 * types and roles an operator picks; the meaning is assigned by the Rule Engine, which is the same
 * separation the platform has held since `Zone` was first declared in `tracking.ts`.
 *
 * ### ⚠️ Two different things in this platform are called a "zone", and confusing them is silent
 *
 * | | **Location-hierarchy zone** | **Detection zone** (this file) |
 * |---|---|---|
 * | owned by | Tenant context (`OrgNode`) | Camera context |
 * | means | a *place* — "Floor 2 East" | an *area of one camera's picture* |
 * | id lives on | `Camera.zoneId`, `RuleScope.nodeIds` | `EventEnvelope.zoneId`, `RuleScope.zoneIds` |
 * | how a subject relates to it | by which camera saw them | by where their feet were in the frame |
 *
 * They are different id spaces with the same word, and a rule scoped to one while matching against
 * the other would fire never or always with no error either way. `ResolvedRuleScope` therefore keeps
 * them in **separate fields** (`zoneIds` for the hierarchy, `detectionZoneIds` for these) rather than
 * sharing one set — see ADR-0044.
 *
 * ### ⚠️ Why this is not `Zone` from `tracking.ts`
 *
 * It **is** — geometrically. `DetectionZone` carries a `Zone`'s `geometry` unchanged and validates it
 * with the same rules, so anything already consuming `Zone` keeps working. What it adds is everything
 * a *stored, operated, audited* asset needs and pure geometry deliberately does not have: a tenant, an
 * enable switch, a version, who last moved the points and when. `Zone` stays what it is — the shape
 * an analyzer receives — and this is the record an operator edits.
 *
 * ### ⚠️ No hardcoded coordinates, anywhere
 *
 * The Architect's requirement, and it is structural rather than a convention: there is no default
 * geometry in this file, no "full frame" fallback, and a zone cannot be created without points. A
 * built-in rectangle covering the frame would be the one zone every deployment silently ended up
 * using, and every incident would name it.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId } from '../common/primitives.js';
import { Point2D, ZoneGeometry, ZoneKind, type Zone } from '../tracking/tracking.js';

/**
 * How the operator drew it (§Zones: Polygon, Rectangle).
 *
 * ⚠️ **A rectangle is stored as four points, not as `x/y/w/h`.** The evaluator therefore has one code
 * path, and a rectangle can be dragged into a quadrilateral without a migration or a second geometry
 * type. This field records the *drawing tool*, so the editor can re-open a rectangle with corner
 * handles instead of four independent vertices — it never changes how the zone is evaluated, and
 * nothing downstream branches on it.
 */
export const ZoneShape = z.enum([
  'polygon',
  'rectangle',
  /**
   * ⚠️ **Declared, storable, and not evaluated.** See `ZONE_EVALUATION` below: the geometry layer
   * accepts a line, the editor can draw one, and the resolver skips it because "inside a polyline" is
   * not a question with an answer. Crossing is a change of side between two frames, which nothing
   * computes yet.
   */
  'line',
  /** ⚠️ Reserved (Architect rec 2) — an ordered route. Nothing produces or evaluates one. */
  'path',
  /** ⚠️ Reserved (Architect rec 2) — a line plus an orientation. Nothing produces or evaluates one. */
  'direction',
]);
export type ZoneShape = z.infer<typeof ZoneShape>;

/**
 * **What the platform can actually do with each geometry** (Architect rec 2).
 *
 * The requirement was: support Polygon and Rectangle now, and design so Line, Path and Direction fit
 * later without a redesign. This table is how that claim is kept checkable rather than asserted.
 *
 * ⚠️ Every shape above is **declarable and storable today** — the enum, the geometry validator and
 * the version history need no change to accept one. What differs is whether anything can *evaluate*
 * it, and that is stated here per shape rather than discovered by an operator who drew a path and
 * waited for an incident. The zone service refuses to create a shape whose `evaluable` is false, so
 * the reserved values cannot silently become configuration that does nothing.
 *
 * A future milestone implements one of these by writing an evaluator and flipping one flag. Nothing
 * about the contract, the storage, the plan, the versioning or the rule scope changes — which is the
 * whole of what "fits without redesign" was supposed to mean.
 */
export const ZONE_EVALUATION: Readonly<
  Record<ZoneShape, { evaluable: boolean; kind: ZoneKind; needs?: string }>
> = {
  polygon: { evaluable: true, kind: 'area' },
  rectangle: { evaluable: true, kind: 'area' },
  line: {
    evaluable: false,
    kind: 'line',
    needs:
      'a side-of-line test carried between frames per subject. Membership is instantaneous; ' +
      'crossing is a transition, so it needs the previous frame — state the resolver does not keep.',
  },
  path: {
    evaluable: false,
    kind: 'line',
    needs:
      'route adherence: distance from a polyline, accumulated over a subject’s trajectory. The ' +
      'trajectory exists on `Track.history`, which media does not carry on the frame path.',
  },
  direction: {
    evaluable: false,
    kind: 'line',
    needs: 'a crossing test (as `line`) plus the sign of the crossing against the segment normal.',
  },
};

/** Whether this deployment can evaluate a shape. ⚠️ The zone service refuses to store what it cannot. */
export function isEvaluableShape(shape: ZoneShape): boolean {
  return ZONE_EVALUATION[shape].evaluable;
}

/**
 * What the zone is *for*, as configuration (AI-4 rec 4's `ZoneRole`, kept open).
 *
 * Advisory metadata for grouping and for the editor's palette. ⚠️ Deliberately **not** an input to
 * evaluation: a rule names the zones it covers by id. A rule that fired on "every zone whose role is
 * checkout" would silently change behaviour the moment somebody re-labelled a zone, which is exactly
 * the class of surprise the explicit-scope design exists to prevent.
 */
export const DetectionZonePurpose = z.string().min(1).max(64);

/** Geometric limits. Generous enough for a hand-drawn zone, small enough that evaluation is free. */
export const ZONE_LIMITS = {
  /** Vertices in one polygon. A hand-drawn zone is 4–12; 64 is far past anything an operator draws. */
  maxPoints: 64,
  /** Zones on one camera. Beyond this the per-frame geometry stops being free — see `zone-resolver`. */
  maxZonesPerCamera: 32,
} as const;

/**
 * A stored, operable detection zone.
 *
 * ⚠️ `version` is bumped on every geometry or enablement change and is carried onto every incident
 * that names the zone. An investigator asking *"where exactly was the queue zone when this happened?"*
 * gets an answer that does not change when somebody drags a vertex next Tuesday.
 */
export const DetectionZone = z.object({
  id: z.string().min(1),
  tenantId: TenantId,
  /** The camera whose image plane this polygon lives on. A zone belongs to exactly one camera. */
  cameraId: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  /** `area` for occupancy/dwell, `line` for a future directional crossing. */
  kind: ZoneKind,
  /** The drawing tool used. Presentation only — see `ZoneShape`. */
  shape: ZoneShape,
  geometry: ZoneGeometry,
  /** Advisory grouping, e.g. `entrance`, `checkout`, `aisle`. Never read while evaluating. */
  purpose: DetectionZonePurpose.optional(),
  /**
   * ⚠️ A disabled zone is **not evaluated and not deleted**. Deleting a zone an incident references
   * would leave that incident pointing at nothing; disabling stops it producing new ones while every
   * past incident still resolves. Rules scoped to it keep their scope and say the zone is off.
   */
  enabled: z.boolean().default(true),
  /** Bumped on every content change. Stamped onto incidents so the past stays readable. */
  version: z.number().int().min(1),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  updatedBy: z.string().max(200).optional(),
  /** Generic extension map, as on `Zone`. No industry semantics. */
  attributes: z.record(z.string(), z.unknown()).default({}),
});
export type DetectionZone = z.infer<typeof DetectionZone>;

export const CreateDetectionZoneInput = z.object({
  cameraId: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  kind: ZoneKind.default('area'),
  shape: ZoneShape.default('polygon'),
  geometry: ZoneGeometry,
  purpose: DetectionZonePurpose.optional(),
  enabled: z.boolean().default(true),
  attributes: z.record(z.string(), z.unknown()).default({}),
});
export type CreateDetectionZoneInput = z.infer<typeof CreateDetectionZoneInput>;

/** Partial update. Any provided field is a content change and bumps `version`. */
export const UpdateDetectionZoneInput = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  kind: ZoneKind.optional(),
  shape: ZoneShape.optional(),
  geometry: ZoneGeometry.optional(),
  purpose: DetectionZonePurpose.optional(),
  enabled: z.boolean().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateDetectionZoneInput = z.infer<typeof UpdateDetectionZoneInput>;

// ---------------------------------------------------------------------------------------------
// Geometry — pure, total, and shared by every consumer that has to decide "inside?"
//
// ⚠️ ONE implementation, exported from the contracts package, used by the camera service (to
// validate), by media (to evaluate, on the frame path) and by the console (to draw). Three
// implementations of point-in-polygon would agree on every test anybody wrote and disagree on the
// edge case that matters, and the disagreement would show up as an incident that fired on one
// deployment and not another.
// ---------------------------------------------------------------------------------------------

/** Why a geometry was refused, in words an editor can render next to the shape. */
export interface ZoneGeometryProblem {
  readonly code:
    'too-few-points' | 'too-many-points' | 'out-of-bounds' | 'degenerate' | 'self-intersecting';
  readonly message: string;
}

/**
 * Validate a zone's geometry for a given kind.
 *
 * ⚠️ **Self-intersection is refused, and that is not fussiness.** A bow-tie polygon has no
 * unambiguous inside: the even-odd rule used by `pointInPolygon` says the crossing lobes are
 * *outside*, the non-zero winding rule says they are inside, and the browser canvas that drew it
 * shaded whichever its renderer preferred. An operator would draw a zone, see it filled, and get an
 * evaluator that disagreed with the picture. Refusing at authoring time is the only place where a
 * person is present to fix it.
 */
export function validateZoneGeometry(
  geometry: ZoneGeometry,
  kind: ZoneKind,
): ZoneGeometryProblem[] {
  const problems: ZoneGeometryProblem[] = [];
  const points = geometry.points;
  const min = kind === 'line' ? 2 : 3;
  if (points.length < min) {
    problems.push({
      code: 'too-few-points',
      message: `a ${kind} needs at least ${min} points, got ${points.length}`,
    });
    return problems;
  }
  if (points.length > ZONE_LIMITS.maxPoints) {
    problems.push({
      code: 'too-many-points',
      message: `at most ${ZONE_LIMITS.maxPoints} points, got ${points.length}`,
    });
  }
  for (const [i, p] of points.entries()) {
    const [x, y] = p;
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      problems.push({
        code: 'out-of-bounds',
        message: `point ${i} (${x}, ${y}) is outside the normalised [0,1] image plane`,
      });
      break;
    }
  }
  if (kind === 'area' && Math.abs(signedArea(points)) < 1e-6) {
    problems.push({
      code: 'degenerate',
      message: 'the polygon encloses no area — its points are collinear or coincident',
    });
  }
  if (kind === 'area' && selfIntersects(points)) {
    problems.push({
      code: 'self-intersecting',
      message: 'the polygon crosses itself, so which part is "inside" is ambiguous',
    });
  }
  return problems;
}

/** Twice the signed area (the shoelace sum). Sign is winding direction; magnitude is area × 2. */
function signedArea(points: readonly Point2D[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [ax, ay] = points[i] as Point2D;
    const [bx, by] = points[(i + 1) % points.length] as Point2D;
    sum += ax * by - bx * ay;
  }
  return sum / 2;
}

/** Do two segments properly cross? Endpoint touches do not count — adjacent edges always touch. */
function segmentsCross(a1: Point2D, a2: Point2D, b1: Point2D, b2: Point2D): boolean {
  const d = (p: Point2D, q: Point2D, r: Point2D): number =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = d(b1, b2, a1);
  const d2 = d(b1, b2, a2);
  const d3 = d(a1, a2, b1);
  const d4 = d(a1, a2, b2);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

function selfIntersects(points: readonly Point2D[]): boolean {
  const n = points.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      /* Skip adjacent edges (they share a vertex) and the closing pair (edge 0 and edge n-1). */
      if (j === i || j === i + 1 || (i === 0 && j === n - 1)) continue;
      const a1 = points[i] as Point2D;
      const a2 = points[(i + 1) % n] as Point2D;
      const b1 = points[j] as Point2D;
      const b2 = points[(j + 1) % n] as Point2D;
      if (segmentsCross(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

/**
 * Is a point inside a polygon? Ray casting with the even-odd rule.
 *
 * ⚠️ **Total and allocation-free.** This runs once per detection per zone per frame on the process
 * that writes recordings, so it may not allocate, may not throw, and may not be `O(n²)`. A polygon of
 * 12 points costs 12 comparisons.
 *
 * ⚠️ Boundary points are **not specified** and deliberately so — a subject exactly on a zone edge is
 * a coin flip, and pretending otherwise would put a tolerance constant in a geometry primitive. What
 * matters is that the answer is *stable*: the same point and the same polygon always give the same
 * result, so a subject standing still on a boundary does not flicker in and out and shred their dwell.
 */
export function pointInPolygon(point: Point2D, polygon: readonly Point2D[]): boolean {
  const [px, py] = point;
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const [ax, ay] = polygon[i] as Point2D;
    const [bx, by] = polygon[j] as Point2D;
    if (ay > py !== by > py) {
      const dy = by - ay;
      /* dy cannot be 0 here: the guard above requires the edge to straddle py. */
      if (px < ax + ((bx - ax) * (py - ay)) / dy) inside = !inside;
    }
  }
  return inside;
}

/**
 * The point on a bounding box that decides zone membership.
 *
 * ⚠️ **Bottom centre — where the subject touches the floor — not the box centre.** This is a real
 * decision with a visible consequence. A person standing just outside a checkout zone has a bounding
 * box whose *centre* drifts inside it as soon as their shoulders overlap the line, because a standing
 * person's box is roughly twice as tall as it is wide. Zones are drawn on the floor by an operator
 * looking at a picture of the floor, so the floor contact point is what they mean.
 *
 * It is wrong for a subject the camera sees from above, and wrong for one whose feet are occluded by
 * a counter — both are recorded in KNOWN_LIMITATIONS rather than corrected with a heuristic that
 * would be wrong somewhere else.
 */
export function zoneAnchor(bbox: readonly [number, number, number, number]): Point2D {
  const [x, y, w, h] = bbox;
  return [x + w / 2, y + h];
}

/** Build the four corners of an axis-aligned rectangle, clockwise from the top-left. */
export function rectanglePoints(x: number, y: number, w: number, h: number): Point2D[] {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

/**
 * The pure-geometry `Zone` view of a stored zone — what an analyzer or evaluator receives.
 *
 * The projection exists so nothing downstream of authoring can read `enabled`, `version` or
 * `updatedBy` and start depending on them. A geometry consumer gets geometry.
 */
export function toZone(zone: DetectionZone): Zone {
  return {
    id: zone.id,
    cameraId: zone.cameraId,
    name: zone.name,
    kind: zone.kind,
    geometry: zone.geometry,
    attributes: zone.attributes,
  };
}

// ---------------------------------------------------------------------------------------------
// Zone versioning (P-8 Phase 7, Architect rec 2) — a historical incident must still resolve the
// geometry that produced it.
// ---------------------------------------------------------------------------------------------

/**
 * An immutable snapshot of a zone at one version.
 *
 * ### ⚠️ The failure this prevents, which looks exactly like success
 *
 * An incident detail page draws the zone over the footage. Without history it draws **today's**
 * polygon over **March's** video — so an operator reviewing a disputed loitering incident sees a
 * person standing well outside the highlighted area and concludes the platform is broken, or sees
 * them comfortably inside it when at the time they were not. Nothing errors. Nothing is logged. The
 * picture is simply, confidently wrong, and it is wrong in a record that may be handed to a customer.
 *
 * ⚠️ **Written on every change, never rewritten, and never garbage-collected on a schedule.** A zone
 * with a hundred edits keeps a hundred rows; they are a few hundred bytes each and they are the only
 * thing standing between an evidence record and a plausible fiction. Retention, if it is ever needed,
 * belongs with the evidence it supports, not with the zone.
 */
export const DetectionZoneVersionRecord = z.object({
  tenantId: TenantId,
  zoneId: z.string().min(1),
  version: z.number().int().min(1),
  changeKind: z.enum(['created', 'geometry-changed', 'renamed', 'enabled', 'disabled', 'deleted']),
  changedBy: z.string().max(200).optional(),
  changedAt: IsoDateTime,
  /** The whole zone at this version — not a diff. See `AssignmentHistoryEntry` for the same choice. */
  snapshot: DetectionZone,
});
export type DetectionZoneVersionRecord = z.infer<typeof DetectionZoneVersionRecord>;

/**
 * A zone as it travels to the enforcement point on the assignment plan (§Zones, ADR-0044).
 *
 * ⚠️ Only what evaluation needs. The plan is polled every 5 seconds by every media process; carrying
 * descriptions and audit fields on it would grow the poll with data nothing on that side reads.
 * `version` rides along because an incident must be able to name the geometry that produced it.
 */
export const PlanZone = z.object({
  zoneId: z.string().min(1),
  name: z.string().min(1),
  kind: ZoneKind,
  points: z.array(Point2D).min(2),
  version: z.number().int().min(1),
});
export type PlanZone = z.infer<typeof PlanZone>;

/** Project a stored zone onto the plan. Disabled zones are filtered by the caller, not here. */
export function toPlanZone(zone: DetectionZone): PlanZone {
  return {
    zoneId: zone.id,
    name: zone.name,
    kind: zone.kind,
    points: zone.geometry.points,
    version: zone.version,
  };
}

/**
 * Per-camera zone-evaluation counters, measured by the enforcement point (§Benchmark).
 *
 * ⚠️ `insideDetections` counts detection-zone *memberships*, not detections: a subject standing in
 * two overlapping zones contributes two. That is what the event fan-out will produce, so it is the
 * number that predicts event volume — which is the question this counter is read to answer.
 */
export const ZoneEvaluationStats = z.object({
  /** Zones this process currently holds geometry for, across every camera. */
  zonesLoaded: z.number().int().nonnegative(),
  /** Cameras with at least one enabled zone. */
  camerasWithZones: z.number().int().nonnegative(),
  /** Detections tested against at least one zone. */
  detectionsTested: z.number().int().nonnegative(),
  /** Detection-zone memberships found. See the warning above. */
  insideDetections: z.number().int().nonnegative(),
  /** Mean wall-clock cost of resolving one frame's detections, or `null` before any were tested. */
  averageResolveMicros: z.number().nonnegative().nullable(),
  /**
   * Memberships carried back to the runtime so the behaviour primitives can read them (ADR-0053).
   *
   * ⛔ **The reading that matters is `insideDetections > 0` with `zoneEchoesSent === 0`.** That is
   * zones resolving correctly and the behaviour layer never hearing about it — exactly the state
   * slice 2.2 shipped, which produced no zone facts at all while every dashboard looked healthy.
   *
   * ⚠️ Optional so an older deployment's stats stay valid; absent means "this build did not measure
   * it", which is a different answer from zero.
   */
  zoneEchoesSent: z.number().int().nonnegative().optional(),
  /**
   * Echoes replaced before they could be sent — the drop rate of the zone join.
   *
   * ⚠️ Non-zero is normal on a busy live camera (frames are answered faster than the next is sent)
   * and should be zero on an offline analysis, which awaits every frame in order.
   */
  zoneEchoesDropped: z.number().int().nonnegative().optional(),
});
export type ZoneEvaluationStats = z.infer<typeof ZoneEvaluationStats>;
