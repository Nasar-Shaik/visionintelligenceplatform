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
  type EventEnvelope,
  type EventSubject,
} from '@vip/contracts';

/** Schema version of the type-specific payload this normalizer emits (additive within a major). */
const PAYLOAD_SCHEMA_VERSION = '1.0.0';

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
  if (Object.keys(detection.attributes).length > 0) subject.attributes = detection.attributes;
  return subject;
}

/** Turn one detection into one envelope (one event per detection in Phase 1). */
function toEnvelope(
  result: DetectionResult,
  detection: Detection,
  deps: NormalizeDeps,
): EventEnvelope {
  const type = eventTypeForLabel(detection.label);
  const priority = lookupEvent(type)?.defaultPriority ?? 'info';
  const envelope: EventEnvelope = {
    id: deps.newId(),
    type,
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
    },
    evidenceRefs: [],
    priority,
  };
  if (result.correlationId) envelope.correlationId = result.correlationId;
  return envelope;
}

export function normalizeDetectionResult(
  result: DetectionResult,
  deps: NormalizeDeps,
): EventEnvelope[] {
  return result.detections.map((d) => toEnvelope(result, d, deps));
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
