/**
 * Deterministic AI validation scenarios — the reusable fixtures the Architect requested for G-3.5.
 * Each is BOTH a regression test (drives the real spine end-to-end) AND a future customer demo. None
 * needs a real model, camera, or GPU: perception scenarios enter as a `DetectionResult` (the exact
 * shape the inference runtime publishes) and drive the events-service normaliser; behaviour /
 * analytics / system scenarios enter as an already-formed semantic `EventEnvelope` (the shape the
 * Python runtime's events.py produces) — see harness.emitEvent + the G-3.5 report (TD-1).
 *
 * Every scenario exercises: Inference/Producer → EventEnvelope → Rule → Incident → Alert → Dashboard.
 */
import type {
  CreateRuleInput,
  DetectionResult,
  EventCategory,
  EventEnvelope,
  EventPriority,
} from '@vip/contracts';
import type { PlatformHarness } from './harness.js';

export interface Scenario {
  /** Stable key (regression id). */
  key: string;
  /** Customer-facing demo title. */
  title: string;
  /** How the event originates: an inference DetectionResult, or a producer-emitted EventEnvelope. */
  entryKind: 'inference' | 'producer';
  /** The canonical catalog event type this scenario asserts on. */
  eventType: string;
  category: EventCategory;
  /** Deterministic correlation id threaded end-to-end for traceability assertions. */
  correlationId: string;
  /** The tenant rule that turns this event into an incident. */
  rule: CreateRuleInput;
  /** Expected raised-incident severity. */
  severity: EventPriority;
  /** Build the deterministic entry payload for a tenant. */
  makeEntry: (tenantId: string) => DetectionResult | EventEnvelope;
}

// --- fixture builders --------------------------------------------------------------------------

function detection(
  tenantId: string,
  overrides: {
    label: string;
    confidence: number;
    capabilityId: string;
    correlationId: string;
    cameraId: string;
    seq: number;
  },
): DetectionResult {
  return {
    tenantId,
    cameraId: overrides.cameraId,
    capabilityId: overrides.capabilityId,
    capabilityVersion: '1.0.0',
    runtimeVersion: '0.1.0',
    executionProvider: 'stub',
    model: {
      name: 'stub-detector',
      version: '1.0.0',
      task: 'object-detection',
      family: '*',
      accelerator: 'cpu',
    },
    frame: { seq: overrides.seq, capturedAt: '2026-07-30T09:00:00.000Z' },
    detections: [
      {
        label: overrides.label,
        confidence: overrides.confidence,
        bbox: [0.1, 0.2, 0.3, 0.4],
        attributes: {},
        metadata: {},
      },
    ],
    inferenceMs: 12,
    correlationId: overrides.correlationId,
    at: '2026-07-30T09:00:00.100Z',
  };
}

function envelope(
  tenantId: string,
  o: {
    id: string;
    type: string;
    category: EventCategory;
    priority: EventPriority;
    correlationId: string;
    cameraId: string;
    capability: string;
    payload: Record<string, unknown>;
    subjectClass: string;
    confidence?: number;
  },
): EventEnvelope {
  const e: EventEnvelope = {
    id: o.id,
    type: o.type,
    envelopeVersion: '1.0.0',
    category: o.category,
    schemaVersion: '1.0.0',
    tenantId,
    cameraId: o.cameraId,
    occurredAt: '2026-07-30T09:00:00.000Z',
    ingestedAt: '2026-07-30T09:00:00.050Z',
    producer: { capability: o.capability, capabilityVersion: '1.0.0', modelVersion: '1.0.0' },
    subjects: [{ class: o.subjectClass, bbox: [0.1, 0.2, 0.3, 0.4] }],
    payload: o.payload,
    evidenceRefs: [],
    priority: o.priority,
    correlationId: o.correlationId,
  };
  if (o.confidence !== undefined) e.confidence = o.confidence;
  return e;
}

/** A rule that raises an incident of `severity` for one event type (optionally gated by a predicate). */
function rule(
  name: string,
  eventType: string,
  severity: EventPriority,
  condition?: CreateRuleInput['condition'],
): CreateRuleInput {
  const r: CreateRuleInput = {
    name,
    lifecycle: 'enabled',
    priority: 100,
    eventTypes: [eventType],
    categories: [],
    severity,
    actions: [{ type: 'raise-incident' }],
  };
  if (condition) r.condition = condition;
  return r;
}

// --- the catalog -------------------------------------------------------------------------------

export const SCENARIOS: Scenario[] = [
  {
    key: 'person-entrance',
    title: 'Person detected at entrance',
    entryKind: 'inference',
    eventType: 'perception.person.detected',
    category: 'perception',
    correlationId: 'corr-person',
    severity: 'medium',
    rule: rule('person at entrance', 'perception.person.detected', 'medium', {
      field: 'confidence',
      op: 'gte',
      value: 0.7,
    }),
    makeEntry: (t) =>
      detection(t, {
        label: 'person',
        confidence: 0.91,
        capabilityId: 'perception.person-detection',
        correlationId: 'corr-person',
        cameraId: 'cam-entrance',
        seq: 1,
      }),
  },
  {
    key: 'fire-warehouse',
    title: 'Fire detected in warehouse',
    entryKind: 'inference',
    eventType: 'perception.fire.detected',
    category: 'safety',
    correlationId: 'corr-fire',
    severity: 'critical',
    rule: rule('fire → critical', 'perception.fire.detected', 'critical'),
    makeEntry: (t) =>
      detection(t, {
        label: 'fire',
        confidence: 0.97,
        capabilityId: 'perception.fire-smoke',
        correlationId: 'corr-fire',
        cameraId: 'cam-warehouse',
        seq: 2,
      }),
  },
  {
    key: 'smoke-server-room',
    title: 'Smoke detected in server room',
    entryKind: 'inference',
    eventType: 'perception.smoke.detected',
    category: 'safety',
    correlationId: 'corr-smoke',
    severity: 'high',
    rule: rule('smoke → high', 'perception.smoke.detected', 'high'),
    makeEntry: (t) =>
      detection(t, {
        label: 'smoke',
        confidence: 0.88,
        capabilityId: 'perception.fire-smoke',
        correlationId: 'corr-smoke',
        cameraId: 'cam-serverroom',
        seq: 3,
      }),
  },
  {
    key: 'camera-offline',
    title: 'Camera offline',
    entryKind: 'producer',
    eventType: 'system.camera.disconnected',
    category: 'system',
    correlationId: 'corr-camoff',
    severity: 'high',
    rule: rule('camera offline → high', 'system.camera.disconnected', 'high'),
    makeEntry: (t) =>
      envelope(t, {
        id: '00000000-0000-4000-8000-0000000000f1',
        type: 'system.camera.disconnected',
        category: 'system',
        priority: 'high',
        correlationId: 'corr-camoff',
        cameraId: 'cam-dock-7',
        capability: 'system.camera-monitor',
        subjectClass: 'camera',
        payload: { cameraId: 'cam-dock-7', reason: 'heartbeat-timeout' },
      }),
  },
  {
    key: 'fight-detected',
    title: 'Fight detected',
    entryKind: 'producer',
    eventType: 'behavior.fight.detected',
    category: 'security',
    correlationId: 'corr-fight',
    severity: 'high',
    rule: rule('fight → high', 'behavior.fight.detected', 'high'),
    makeEntry: (t) =>
      envelope(t, {
        id: '00000000-0000-4000-8000-0000000000f2',
        type: 'behavior.fight.detected',
        category: 'security',
        priority: 'high',
        correlationId: 'corr-fight',
        cameraId: 'cam-lobby',
        capability: 'behavior.fight-detection',
        subjectClass: 'person',
        confidence: 0.82,
        payload: { participants: 2 },
      }),
  },
  {
    key: 'queue-threshold',
    title: 'Queue exceeds threshold',
    entryKind: 'producer',
    eventType: 'analytics.queue.length',
    category: 'analytics',
    correlationId: 'corr-queue',
    severity: 'medium',
    rule: rule('queue ≥ 10 → medium', 'analytics.queue.length', 'medium', {
      field: 'payload.count',
      op: 'gte',
      value: 10,
    }),
    makeEntry: (t) =>
      envelope(t, {
        id: '00000000-0000-4000-8000-0000000000f3',
        type: 'analytics.queue.length',
        category: 'analytics',
        priority: 'info',
        correlationId: 'corr-queue',
        cameraId: 'cam-checkout-3',
        capability: 'analytics.queue-analytics',
        subjectClass: 'queue',
        payload: { count: 14 },
      }),
  },
  {
    key: 'ppe-violation',
    title: 'PPE violation',
    entryKind: 'producer',
    eventType: 'safety.ppe.violation',
    category: 'safety',
    correlationId: 'corr-ppe',
    severity: 'high',
    rule: rule('ppe violation → high', 'safety.ppe.violation', 'high'),
    makeEntry: (t) =>
      envelope(t, {
        id: '00000000-0000-4000-8000-0000000000f4',
        type: 'safety.ppe.violation',
        category: 'safety',
        priority: 'high',
        correlationId: 'corr-ppe',
        cameraId: 'cam-floor-2',
        capability: 'perception.ppe-detection',
        subjectClass: 'person',
        confidence: 0.9,
        payload: { missing: ['hard-hat'] },
      }),
  },
  {
    key: 'loitering',
    title: 'Loitering detected',
    entryKind: 'producer',
    eventType: 'behavior.loitering.detected',
    category: 'security',
    correlationId: 'corr-loiter',
    severity: 'medium',
    rule: rule('loitering → medium', 'behavior.loitering.detected', 'medium'),
    makeEntry: (t) =>
      envelope(t, {
        id: '00000000-0000-4000-8000-0000000000f5',
        type: 'behavior.loitering.detected',
        category: 'security',
        priority: 'medium',
        correlationId: 'corr-loiter',
        cameraId: 'cam-atm',
        capability: 'behavior.loitering-detection',
        subjectClass: 'person',
        confidence: 0.77,
        payload: { dwellSeconds: 240 },
      }),
  },
  {
    key: 'theft-suspected',
    title: 'Theft suspected',
    entryKind: 'producer',
    eventType: 'behavior.theft.suspected',
    category: 'security',
    correlationId: 'corr-theft',
    severity: 'high',
    rule: rule('theft → high', 'behavior.theft.suspected', 'high'),
    makeEntry: (t) =>
      envelope(t, {
        id: '00000000-0000-4000-8000-0000000000f6',
        type: 'behavior.theft.suspected',
        category: 'security',
        priority: 'high',
        correlationId: 'corr-theft',
        cameraId: 'cam-aisle-9',
        capability: 'behavior.theft-detection',
        subjectClass: 'person',
        confidence: 0.8,
        payload: { concealment: true },
      }),
  },
];

/** Emit a scenario's entry through the correct data-plane door (does NOT seed its rule). */
export async function emitScenario(
  harness: PlatformHarness,
  tenantId: string,
  scenario: Scenario,
): Promise<void> {
  const entry = scenario.makeEntry(tenantId);
  if (scenario.entryKind === 'inference') {
    await harness.emitDetection(entry as DetectionResult);
  } else {
    await harness.emitEvent(entry as EventEnvelope);
  }
}

/** Seed a scenario's rule and emit its entry through the correct data-plane door. */
export async function runScenario(
  harness: PlatformHarness,
  tenantId: string,
  scenario: Scenario,
): Promise<void> {
  await harness.seedRule(tenantId, scenario.rule);
  await emitScenario(harness, tenantId, scenario);
}
