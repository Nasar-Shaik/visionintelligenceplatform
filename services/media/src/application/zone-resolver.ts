/**
 * Application: **which zones was each subject standing in?** (P-8 Phase 7 §Zones).
 *
 * Pure geometry over a `DetectionResult` the runtime just returned, run on the process that writes
 * recordings, before the result is published. It is the one place in the platform where a detection
 * acquires a zone.
 *
 * ### ⚠️ Why here, and not in the AI runtime or in the rule engine
 *
 * - **Not the runtime.** AI Runtime Architecture v1.0 is frozen. Pushing zone configuration into it
 *   would be a new pipeline stage and a new configuration channel, which the standing guardrails
 *   forbid — and zones would then be perception's business, which they are not: a polygon is
 *   deployment configuration, not a model.
 * - **Not the rule engine.** The engine sees `EventEnvelope`s and holds no geometry. Giving it
 *   polygons would mean a camera-service lookup per rule per event, which is precisely the shape
 *   PLATFORM_BOUNDARIES rule 4 exists to prevent.
 * - **Here**, because media is already the only service that talks to the runtime, already polls the
 *   assignment plan every five seconds, and already holds the `DetectionResult` with its bounding
 *   boxes in memory. Zones ride on the plan; this costs one poll field and no new integration.
 *
 * ### ⚠️ Cost, stated because this is the hot path
 *
 * `O(detections × zones)` point-in-polygon tests per frame, each a loop over ≤ 64 vertices with no
 * allocation. At the platform's conservative sizing — 16 cameras, 2 fps, a handful of people, a
 * handful of zones — that is a few thousand floating-point comparisons a second, which is nothing.
 * It is bounded by `ZONE_LIMITS.maxZonesPerCamera` rather than left to grow, because "nothing" and
 * "unbounded" are one configuration mistake apart.
 *
 * ### ⚠️ The result is written into `Detection.attributes`, and that is deliberate
 *
 * `DetectionResult` is one of the five frozen contracts. `attributes` is its declared open map, and
 * writing into it is the additive path the freeze explicitly permits — no new field, no schema bump,
 * and a consumer that has never heard of zones is unaffected. The events service reads the key back
 * out when it normalises; nothing else in the platform reads it.
 */
import {
  pointInPolygon,
  zoneAnchor,
  type PlanZone,
  type ZoneMembershipEcho,
} from '@vip/contracts';

/** ⚠️ The tuple form, not the zod schema. `BBox` is exported as a value, so `type BBox` is the schema. */
type Box = [number, number, number, number];

/**
 * The attribute key a detection's zone memberships are written under.
 *
 * ⚠️ Exported and referenced by the events normalizer rather than spelled twice. Two string literals
 * that must agree is a defect waiting for a typo, and it would fail *silently*: every event would
 * simply carry no zone, and loitering would quietly never fire.
 */
export const ZONE_ATTRIBUTE = 'zoneIds';

/** What one frame's resolution cost and found. */
export interface ZoneResolution {
  /** Detections tested against at least one zone. */
  tested: number;
  /** Detection-zone memberships found. ⚠️ A subject in two zones contributes two. */
  inside: number;
}

interface DetectionLike {
  bbox: Box;
  attributes?: Record<string, unknown>;
}

/**
 * Stamp zone memberships onto a frame's detections.
 *
 * ⚠️ **Mutates `attributes` in place.** The result was parsed a moment ago and is about to be
 * published; copying it to add one key would allocate a fresh object graph per frame per camera on
 * the process that must not stall. The mutation is confined to a key this module owns.
 *
 * ⚠️ A detection inside **no** zone gets no attribute at all, rather than an empty array. The events
 * normalizer branches on presence, and an empty array would be a third state meaning the same thing
 * as absence — which is how two consumers end up disagreeing about what "no zones" looks like.
 */
export function resolveZones(
  detections: readonly DetectionLike[],
  zones: readonly PlanZone[],
): ZoneResolution {
  if (zones.length === 0 || detections.length === 0) return { tested: 0, inside: 0 };

  let tested = 0;
  let inside = 0;
  for (const detection of detections) {
    /*
     * ⚠️ The **floor contact point**, not the box centre. A standing person's box is about twice as
     * tall as it is wide, so its centre drifts into a zone as soon as their shoulders cross the line
     * — while the operator who drew the zone on the floor meant their feet. See `zoneAnchor`.
     */
    const anchor = zoneAnchor(detection.bbox);
    tested += 1;
    let hits: string[] | undefined;
    for (const zone of zones) {
      /*
       * ⚠️ A `line` zone has no interior, so membership is undefined for it and it is skipped rather
       * than tested. Line crossing is a change of side between frames, which nothing computes yet —
       * recorded in `FUTURE_WORKFLOW_COVERAGE` as the gap it is. Feeding a polyline to a
       * point-in-polygon test would return a confident answer that means nothing.
       */
      if (zone.kind !== 'area') continue;
      if (!pointInPolygon(anchor, zone.points)) continue;
      (hits ??= []).push(zone.zoneId);
      inside += 1;
    }
    if (hits !== undefined) {
      (detection.attributes ??= {})[ZONE_ATTRIBUTE] = hits;
    }
  }
  return { tested, inside };
}

/** The subset of a detection this module needs to build an echo — identity plus what it was given. */
interface IdentifiedDetection {
  identityId?: string | undefined;
  attributes?: Record<string, unknown> | undefined;
}

/**
 * ⭐ **The membership, addressed back to the runtime that produced the boxes** (ADR-0053).
 *
 * A polygon test needs the boxes inference produces, so this module necessarily runs *after* `/infer`
 * answers — one hop too late for the behaviour primitives that read zones. This turns what was just
 * resolved into an observation the caller carries back on the **next** request for the same camera,
 * where the runtime attaches it to the track history it already holds.
 *
 * ⚠️ **`frameSeq` is the frame these memberships describe**, not the frame that will carry them. With
 * more than one request in flight per camera the two differ, and the runtime matches on this rather
 * than on "the newest point" for exactly that reason.
 *
 * ⚠️ Keyed by `identityId`, never `trackingId` (ADR-0038/0041) — the accumulating primitives that
 * read this group by identity, and a membership attributed to a track id would split one person's
 * dwell in two the first time they walked behind a display.
 *
 * ⛔ **An empty `subjects` is returned, not suppressed, and that is the load-bearing part.** The echo
 * is built whenever the camera has zones at all, so its arrival tells the runtime that *this whole
 * frame* has been decided — the named subjects were inside those zones and every other subject on the
 * frame was inside none. Suppressing the empty case would make "nobody was in a zone" and "the
 * membership never arrived" the same absence, and every duration computed across it would be a lower
 * bound that nothing labelled as one. It is the same rule `resolveZones` follows one level down, read
 * from the other end.
 */
export function membershipEcho(
  detections: readonly IdentifiedDetection[],
  frameSeq: number,
  zoneVersion: number,
  limit = 64,
): ZoneMembershipEcho {
  const subjects: ZoneMembershipEcho['subjects'] = [];
  for (const detection of detections) {
    if (subjects.length >= limit) break;
    const identityId = detection.identityId;
    if (typeof identityId !== 'string' || identityId === '') continue;
    const zoneIds = zonesOf(detection.attributes);
    if (zoneIds.length === 0) continue;
    subjects.push({ identityId, zoneIds });
  }
  return { frameSeq, zoneVersion, subjects };
}

/**
 * Read a detection's zone memberships back.
 *
 * ⚠️ Defensive: the attribute crossed a service boundary and a broker to get here, and `attributes`
 * is an open map anything may write to. A non-array, or an array of non-strings, is treated as no
 * zones rather than trusted — the alternative is a malformed value becoming a `zoneId` on an event
 * and then the primary key of an incident.
 */
export function zonesOf(attributes: Record<string, unknown> | undefined): string[] {
  const raw = attributes?.[ZONE_ATTRIBUTE];
  if (!Array.isArray(raw)) return [];
  return raw.filter((z): z is string => typeof z === 'string' && z.length > 0);
}

/**
 * A rolling mean of the per-frame resolve cost, for the zone-evaluation metrics.
 *
 * ⚠️ `null` until something has been measured — never `0`. "Resolving zones is free" and "no zones
 * have been resolved" look identical as a zero and mean opposite things (ADR-0039).
 */
export class ResolveTimer {
  readonly #samples: number[] = [];
  readonly #size: number;

  constructor(size = 128) {
    this.#size = size;
  }

  add(micros: number): void {
    this.#samples.push(micros);
    if (this.#samples.length > this.#size) this.#samples.shift();
  }

  get average(): number | null {
    if (this.#samples.length === 0) return null;
    return this.#samples.reduce((a, b) => a + b, 0) / this.#samples.length;
  }
}
