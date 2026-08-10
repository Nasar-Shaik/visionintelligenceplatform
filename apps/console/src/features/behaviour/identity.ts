import type {
  AnalysisTimeline,
  AnalysisTimelineIncident,
  BehaviourTimelineEntry,
  TrackHistoryRecordView,
} from '@vip/contracts';

/**
 * **Joining one identity to everything the platform knows about it** (Phase 2.4 slice 2.8) — pure,
 * tested, and deliberately narrow.
 *
 * ### ⛔ The incident join is by RECORDED LINK, never by time
 *
 * An incident carries `triggeredByEventId`; the analysis timeline entry with that id carries the
 * `trackId` the rule fired on; a behaviour identity carries every `trackId` it was assembled from.
 * That is a chain of stored references, and it either resolves or it does not.
 *
 * The tempting alternative is to match on the clock: an incident at 12.4 s and a subject in view at
 * 12.4 s. On a recording with one person that is right every time, which is exactly what makes it
 * dangerous — it looks correct in every demonstration and attributes an incident to the wrong person
 * the first time two people are in shot. So an incident whose link cannot be resolved is **counted
 * and named as unattributable**, and never silently attached to whoever was nearby.
 */

export interface IdentityIncidents {
  /** Incidents whose stored trigger resolves to one of this identity's tracks. */
  attributed: AnalysisTimelineIncident[];
  /**
   * ⛔ Incidents this run raised that could **not** be attributed to any subject — no
   * `triggeredByEventId`, or an event carrying no `trackId`. Reported so an identity page never
   * reads as "this person caused nothing" when the truth is "the link was not recorded".
   */
  unattributable: number;
}

export function incidentsForIdentity(
  timeline: Pick<AnalysisTimeline, 'entries' | 'incidents'> | undefined,
  trackIds: readonly string[],
): IdentityIncidents {
  if (timeline === undefined) return { attributed: [], unattributable: 0 };

  const trackOfEvent = new Map<string, string>();
  for (const entry of timeline.entries) {
    if (entry.trackId !== undefined) trackOfEvent.set(entry.eventId, entry.trackId);
  }

  const mine = new Set(trackIds);
  const attributed: AnalysisTimelineIncident[] = [];
  let unattributable = 0;

  for (const incident of timeline.incidents) {
    const eventId = incident.triggeredByEventId;
    const trackId = eventId === undefined ? undefined : trackOfEvent.get(eventId);
    if (trackId === undefined) {
      unattributable += 1;
      continue;
    }
    if (mine.has(trackId)) attributed.push(incident);
  }

  return { attributed, unattributable };
}

/** One kind of thing this identity did, and how often. */
export interface IdentityFactCount {
  kind: string;
  count: number;
  /** Total seconds across every interval of this kind. `undefined` when the kind has no duration. */
  seconds: number | undefined;
}

/**
 * What one identity did, counted from the timeline the runtime returned.
 *
 * ⚠️ **Counting, not computing.** Every number here is a tally or a sum of durations the runtime
 * already stated; nothing is derived that the runtime did not say. A console that computed a dwell
 * of its own would eventually disagree with the timeline about one, and nothing on the page could
 * say which was right.
 */
export function summariseIdentity(
  entries: readonly BehaviourTimelineEntry[],
  identityId: string,
): IdentityFactCount[] {
  const tally = new Map<string, { count: number; seconds: number; timed: number }>();
  for (const entry of entries) {
    if (entry.identityId !== identityId) continue;
    const found = tally.get(entry.kind) ?? { count: 0, seconds: 0, timed: 0 };
    found.count += 1;
    if (entry.seconds !== undefined && Number.isFinite(entry.seconds)) {
      found.seconds += entry.seconds;
      found.timed += 1;
    }
    tally.set(entry.kind, found);
  }
  return [...tally.entries()]
    .map(([kind, v]) => ({
      kind,
      count: v.count,
      /* ⚠️ `undefined` rather than 0 when no entry of this kind carried a duration: an instant has
       * no length, and "0.0 s" on a screen reads as "immediately", which is a different claim. */
      seconds: v.timed === 0 ? undefined : Math.round(v.seconds * 10) / 10,
    }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

/** Which zones an identity was recorded inside, with how many observations said so. */
export interface ZonePresence {
  zoneId: string;
  observations: number;
}

/**
 * Zones from the **stored observations**, not from the zone-visit primitives.
 *
 * ⚠️ The two can legitimately differ and the difference is informative: a `zoneVisit` needs
 * consecutive settled points, so a subject seen inside a zone for a single frame appears here and
 * produces no visit. Showing the raw membership beside the visits is what makes that visible rather
 * than looking like a missing primitive.
 *
 * ### ⛔ Settled means `zoneIds` is PRESENT — not `zonesSettled === true`
 *
 * `HistoryPoint.to_dict` omits `zoneIds` entirely when membership was never decided and emits `[]`
 * when something decided the answer was "inside none". There is no boolean on the wire. The first
 * version of this function looked for one, found `undefined`, and reported **every** observation as
 * undecided — which on a deployment with zones wired correctly is a confident wrong number that
 * renders exactly like the truth. Caught by running it against the deployment, not by a test.
 */
export function zonesOf(record: TrackHistoryRecordView | undefined): {
  zones: ZonePresence[];
  settledPoints: number;
  unsettledPoints: number;
} {
  if (record === undefined) return { zones: [], settledPoints: 0, unsettledPoints: 0 };
  const tally = new Map<string, number>();
  let settled = 0;
  let unsettled = 0;
  for (const point of record.points) {
    if (!Array.isArray(point.zoneIds)) {
      unsettled += 1;
      continue;
    }
    settled += 1;
    for (const zoneId of point.zoneIds) tally.set(zoneId, (tally.get(zoneId) ?? 0) + 1);
  }
  return {
    zones: [...tally.entries()]
      .map(([zoneId, observations]) => ({ zoneId, observations }))
      .sort((a, b) => b.observations - a.observations || a.zoneId.localeCompare(b.zoneId)),
    settledPoints: settled,
    unsettledPoints: unsettled,
  };
}

/** The centre of a normalised `[x, y, w, h]` box — a drawing convenience, not a stored fact. */
export function centreOf(bbox: readonly [number, number, number, number]): [number, number] {
  return [bbox[0] + bbox[2] / 2, bbox[1] + bbox[3] / 2];
}

/**
 * The detector's confidence across an identity's observations.
 *
 * ⭐ **The only confidence this platform has for a behaviour fact**, and it belongs to the
 * *detection*, not to the primitive. A primitive is a geometric measurement against a published
 * threshold — it met the threshold or it did not — so there is no probability attached to
 * "lingered", and the surface says which of the two numbers it is showing.
 *
 * ⚠️ `null` when nothing was observed, never 0.
 */
export function detectionConfidence(record: TrackHistoryRecordView | undefined): {
  min: number;
  mean: number;
  max: number;
} | null {
  const scores = (record?.points ?? [])
    .map((p) => p.confidence)
    .filter((c): c is number => typeof c === 'number' && Number.isFinite(c));
  if (scores.length === 0) return null;
  const sum = scores.reduce((a, b) => a + b, 0);
  return {
    min: Math.min(...scores),
    mean: sum / scores.length,
    max: Math.max(...scores),
  };
}
