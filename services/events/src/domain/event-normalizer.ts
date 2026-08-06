/**
 * Domain: normalize a capability output (`DetectionResult`) into zero-or-more `EventEnvelope`s and
 * compute each envelope's **dedup key**. Pure — no I/O, no framework (layering rule). This is where
 * a model-independent detection becomes a domain-neutral event (Law 1): the label is mapped to a
 * catalog event type, provenance/timing/subjects are carried through, and priority comes from the
 * event catalog. The dedup key follows docs/architecture/09 §Deduplication — `type + subject/track +
 * zone + time-bucket` — so at-least-once redelivery AND a subject repeated within the window both
 * collapse to a single persisted event.
 */
import {
  lookupEvent,
  type Detection,
  type DetectionResult,
  type EventCategory,
  type EventEnvelope,
  type EventSubject,
} from '@vip/contracts';

/** Schema version of the type-specific payload this normalizer emits (additive within a major). */
const PAYLOAD_SCHEMA_VERSION = '1.0.0';
/** Version of the EventEnvelope structure this normalizer emits (contract evolution; P1-5 rec 1). */
const ENVELOPE_VERSION = '1.0.0';

/**
 * Map a generic detection label to a domain-neutral catalog event type. Unknown labels fall back to
 * the generic `perception.object.detected` so a new capability never produces an uncatalogued type.
 */
const LABEL_TO_EVENT_TYPE: Record<string, string> = {
  person: 'perception.person.detected',
  pedestrian: 'perception.person.detected',
  vehicle: 'perception.vehicle.detected',
  car: 'perception.vehicle.detected',
  truck: 'perception.vehicle.detected',
  bus: 'perception.vehicle.detected',
  motorcycle: 'perception.vehicle.detected',
  fire: 'perception.fire.detected',
  flame: 'perception.fire.detected',
  smoke: 'perception.smoke.detected',
};

export function eventTypeForLabel(label: string): string {
  return LABEL_TO_EVENT_TYPE[label.toLowerCase()] ?? 'perception.object.detected';
}

export interface NormalizeDeps {
  /** Ingestion timestamp source. */
  now: () => Date;
  /** Fresh envelope id (uuid) per detection. */
  newId: () => string;
}

function subjectOf(detection: Detection): EventSubject {
  const subject: EventSubject = { class: detection.label, bbox: detection.bbox };
  if (detection.trackingId) subject.trackId = detection.trackingId;
  /*
   * ⚠️ Identity is carried through, and it is the field a rule must aggregate on (ADR-0041). A
   * dwell rule keyed on `trackId` sees a briefly occluded person as two short visits and never
   * crosses its threshold — silently, and more often as the host saturates. Dropping it here would
   * put that failure back with nothing to see.
   */
  if (detection.identityId) subject.identityId = detection.identityId;
  if (detection.precededBy) subject.precededBy = detection.precededBy;
  if (Object.keys(detection.attributes).length > 0) subject.attributes = detection.attributes;
  return subject;
}

/** Turn one detection into one envelope (one event per detection in Phase 1). */
/**
 * The attribute key media stamps a detection's zone memberships under (P-8 Phase 7).
 *
 * ⚠️ **This string must equal `ZONE_ATTRIBUTE` in `services/media`**, and the two cannot import each
 * other — they are separate services joined by a broker. The failure mode of a mismatch is silent and
 * total: every event would carry no zone, every zone-scoped rule would decline at the scope stage,
 * and loitering would simply never fire with nothing in any log. The end-to-end verification asserts
 * a zone actually arrives on an envelope for exactly this reason; no unit test on either side can.
 */
const ZONE_ATTRIBUTE = 'zoneIds';

/**
 * The detection zones a subject was standing in, as media measured them.
 *
 * ⚠️ Defensive. `attributes` is an open map that crossed a service boundary and a broker, so a
 * non-array or a non-string member is treated as absent rather than trusted — the alternative is a
 * malformed value becoming an envelope's `zoneId` and then an incident's primary key.
 */
function zonesOf(detection: Detection): string[] {
  const raw = detection.attributes[ZONE_ATTRIBUTE];
  if (!Array.isArray(raw)) return [];
  return raw.filter((z): z is string => typeof z === 'string' && z.length > 0);
}

function toEnvelope(
  result: DetectionResult,
  detection: Detection,
  deps: NormalizeDeps,
  /** The detection zone this envelope is about, when the subject was inside one (P-8 Phase 7). */
  zoneId?: string,
): EventEnvelope {
  const type = eventTypeForLabel(detection.label);
  const entry = lookupEvent(type);
  const priority = entry?.defaultPriority ?? 'info';
  const category: EventCategory = entry?.category ?? 'perception';
  const envelope: EventEnvelope = {
    id: deps.newId(),
    type,
    envelopeVersion: ENVELOPE_VERSION,
    category,
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
    tenantId: result.tenantId,
    cameraId: result.cameraId,
    occurredAt: result.frame.capturedAt,
    ingestedAt: deps.now().toISOString(),
    producer: {
      capability: result.capabilityId,
      capabilityVersion: result.capabilityVersion,
      modelVersion: result.model.version,
    },
    confidence: detection.confidence,
    subjects: [subjectOf(detection)],
    payload: {
      label: detection.label,
      executionProvider: result.executionProvider,
      runtimeVersion: result.runtimeVersion,
      /*
       * ⚠️ The FRAME this event came from (P-8 Phase 5). Every envelope from one frame shares a
       * `correlationId`; these say which frame that was, so a trace can be followed in both
       * directions — from an incident back to the frame, and from a frame forward to everything it
       * produced.
       *
       * ⚠️ In the PAYLOAD, not the envelope. A frame sequence is meaningless for `tenant.created`,
       * and an envelope field carried by every event on the platform forever needs a higher bar
       * than one carried by perception events (ADR-0040).
       */
      frameId: `${result.tenantId}:${result.cameraId}:${result.frame.seq}`,
      frameSeq: result.frame.seq,
    },
    evidenceRefs: [],
    priority,
  };
  /*
   * ⚠️ The **detection zone**, not a location-hierarchy node (P-8 Phase 7).
   *
   * `EventEnvelope.zoneId` sat beside `branchId`/`siteId` and was documented as spatial scoping, and
   * nothing had ever set it. From this milestone it carries the zone the platform can actually
   * *observe*: the polygon on the camera the subject was standing in. The rule engine's scope stage
   * keeps the two id spaces in separate sets (`zoneIds` vs `detectionZoneIds`) precisely so neither
   * can be silently matched against the other. See ADR-0044.
   */
  if (zoneId !== undefined) envelope.zoneId = zoneId;

  // Correlation is threaded end-to-end (P1-8 Architect rec 1): use the detection's correlation id
  // when present, else anchor the chain to this event's own id so every downstream artifact
  // (candidate → incident → notification) shares a correlation key.
  envelope.correlationId = result.correlationId ?? envelope.id;
  return envelope;
}

/**
 * One detection becomes **one envelope per zone it was inside**, or one zoneless envelope when it was
 * inside none (P-8 Phase 7).
 *
 * ### ⚠️ Why a fan-out rather than a list of zones on one envelope
 *
 * "A person is in the checkout queue" and "a person is in the aisle" are two facts, and a rule scoped
 * to the queue must see the first without the second. `EventEnvelope.zoneId` is a single value — one
 * event, one place — and a rule matching against an *array* would need the scope stage to do set
 * intersection per event per rule, which is exactly the per-event cost the compiled-scope design
 * exists to avoid.
 *
 * ### ⚠️ Volume, and why it does not explode
 *
 * A camera with one loitering zone produces the same number of events as before: subjects inside it
 * get one zoned event, subjects outside get one zoneless one. Volume only grows where zones actually
 * **overlap**, which is a deliberate act by an operator. The zone-evaluation metrics report
 * `insideDetections` as *memberships* rather than detections for precisely this reason — it is the
 * number that predicts this fan-out.
 *
 * ### ⚠️ A subject in no zone still produces its event
 *
 * Unchanged from before this milestone, and it must stay that way: tenant-wide and camera-scoped
 * rules, every existing verification, and every consumer of `perception.person.detected` depend on
 * it. Suppressing zoneless events would have made zones a switch that silently disabled everything
 * else on the camera.
 */
export function normalizeDetectionResult(
  result: DetectionResult,
  deps: NormalizeDeps,
): EventEnvelope[] {
  const envelopes: EventEnvelope[] = [];
  for (const detection of result.detections) {
    const zones = zonesOf(detection);
    if (zones.length === 0) {
      envelopes.push(toEnvelope(result, detection, deps));
      continue;
    }

    /*
     * ⚠️ **The zone envelopes of ONE detection share one correlation chain.**
     *
     * `toEnvelope` falls back to `correlationId = its own id` when the producer supplied none — which
     * P-8 Phase 5 already recorded as a defect and fixed at the publisher, where every result is
     * stamped with its frame id. The fan-out makes the fallback worse in a new way: one person
     * standing in two overlapping zones would produce two envelopes about *the same subject in the
     * same frame* on two unrelated traces, so "what did this person do" could not be answered even in
     * principle.
     *
     * Anchoring the group to its first envelope costs nothing and is correct for any producer. The
     * broader case — separate detections in one frame — is deliberately left as it is: it is the
     * publisher's job, it is already done there, and changing it here would alter the correlation of
     * every event on the platform to fix something that is not broken in the deployment.
     */
    const group = zones.map((zoneId) => toEnvelope(result, detection, deps, zoneId));
    const anchor = result.correlationId ?? group[0]?.id;
    for (const envelope of group) {
      if (anchor !== undefined) envelope.correlationId = anchor;
      envelopes.push(envelope);
    }
  }
  return envelopes;
}

/**
 * The dedup key for an envelope. Identity within a tenant is `type + camera + zone + subject/track +
 * time-bucket`; a redelivery or a rapid repeat of the same subject shares the key and is collapsed.
 * `subject/track` prefers a stable track id, else the subject class, so two distinct tracks in the
 * same bucket stay distinct.
 */
export function dedupKey(envelope: EventEnvelope, windowMs: number): string {
  const subject = envelope.subjects[0];
  const track = subject?.trackId ?? subject?.class ?? '-';
  const zone = envelope.zoneId ?? '-';
  const camera = envelope.cameraId ?? '-';
  const bucket =
    windowMs > 0 ? Math.floor(Date.parse(envelope.occurredAt) / windowMs) : envelope.id;
  return [envelope.tenantId, envelope.type, camera, zone, track, bucket].join('|');
}
