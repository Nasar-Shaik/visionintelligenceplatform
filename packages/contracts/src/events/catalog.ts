/**
 * Event catalog data (docs/architecture/09 §2) — the machine-readable registry binding each event
 * `type` to its metadata (category, priority, PII, producer). The **single source of truth** for the
 * Inference Runtime, Rule Engine, Dashboard, Alerts, Incidents, and future clients.
 *
 * Modular by concern (P2-2 G-3):
 *   - [event-types.ts](event-types.ts)  — the canonical type-string constants, grouped by domain.
 *   - [schema.ts](schema.ts)            — the `EventCatalogEntry` / `PiiClass` shapes.
 *   - [validation.ts](validation.ts)    — `assertKnownEventType` / format helpers.
 *   - this file                          — the assembled entries + `lookupEvent`/`isKnownEventType`.
 *
 * Adding an event type = a constant in event-types.ts + an entry here (additive; never rename).
 */
import type { EventCatalogEntry } from './schema.js';

export { PiiClass, EventCatalogEntry } from './schema.js';

/**
 * Seed catalog. Keep entries grouped by domain. Extend, never rename.
 */
export const EVENT_CATALOG: EventCatalogEntry[] = [
  // tenant / platform lifecycle (control-plane; no capability producer)
  {
    type: 'tenant.created',
    category: 'system',
    description: 'A tenant was provisioned (org root + admin seeded downstream).',
    defaultPriority: 'high',
    pii: 'none',
  },
  {
    type: 'tenant.activated',
    category: 'system',
    description: 'A tenant became active.',
    defaultPriority: 'low',
    pii: 'none',
  },
  {
    type: 'tenant.suspended',
    category: 'system',
    description: 'A tenant was suspended (access denied; data retained).',
    defaultPriority: 'high',
    pii: 'none',
  },
  {
    type: 'tenant.deprovisioned',
    category: 'system',
    description: 'A tenant was deprovisioned (data purge + token revocation).',
    defaultPriority: 'high',
    pii: 'none',
  },
  {
    type: 'org.node.created',
    category: 'system',
    description: 'An organizational-hierarchy node was created under a tenant.',
    defaultPriority: 'info',
    pii: 'none',
  },
  // identity / auth (control-plane)
  {
    type: 'user.created',
    category: 'security',
    description: 'A user was created under a tenant.',
    defaultPriority: 'low',
    pii: 'low',
  },
  {
    type: 'auth.login.succeeded',
    category: 'security',
    description: 'A principal authenticated successfully.',
    defaultPriority: 'info',
    pii: 'low',
  },
  {
    type: 'auth.token.refreshed',
    category: 'security',
    description: 'A refresh token was rotated for a new access token.',
    defaultPriority: 'info',
    pii: 'none',
  },
  {
    type: 'auth.refresh.reused',
    category: 'security',
    description: 'A used/rotated refresh token was replayed — token family revoked (compromise).',
    defaultPriority: 'high',
    pii: 'none',
  },
  {
    type: 'auth.logout',
    category: 'security',
    description: 'A principal logged out (refresh token/family revoked).',
    defaultPriority: 'low',
    pii: 'none',
  },
  // camera inventory (control-plane; P1-3)
  {
    type: 'camera.registered',
    category: 'system',
    description: 'A camera was onboarded under a tenant (consumed by media/ingestion).',
    defaultPriority: 'low',
    pii: 'none',
  },
  {
    type: 'camera.updated',
    category: 'system',
    description: 'A camera’s configuration changed (zone, stream, capture, status, credentials).',
    defaultPriority: 'info',
    pii: 'none',
  },
  {
    type: 'camera.removed',
    category: 'system',
    description: 'A camera was removed from the inventory (ingestion should stop).',
    defaultPriority: 'low',
    pii: 'none',
  },
  {
    type: 'camera.health.changed',
    category: 'system',
    description: 'A camera’s observed health transitioned (unknown/online/offline/unhealthy).',
    defaultPriority: 'medium',
    pii: 'none',
  },
  // media / ingestion (P1-4)
  {
    type: 'media.stream.connected',
    category: 'system',
    description: 'A camera stream connected and is producing frames.',
    defaultPriority: 'low',
    pii: 'none',
  },
  {
    type: 'media.stream.lost',
    category: 'system',
    description: 'A camera stream was lost; the worker is reconnecting with backoff.',
    defaultPriority: 'high',
    pii: 'none',
  },
  {
    type: 'media.recording.segment',
    category: 'system',
    description: 'A media segment was recorded to tenant-scoped object storage.',
    defaultPriority: 'info',
    pii: 'none',
  },
  // device / lifecycle
  {
    type: 'device.camera.offline',
    category: 'system',
    description: 'A camera stopped reporting/heartbeat.',
    defaultPriority: 'high',
    pii: 'none',
  },
  {
    type: 'device.camera.online',
    category: 'system',
    description: 'A camera resumed reporting.',
    defaultPriority: 'low',
    pii: 'none',
  },
  // inference runtime health (P2-2 G-3). The runtime emits an EventEnvelope on model failure — it
  // NEVER creates an incident directly; rules/workflow decide what a failure means.
  {
    type: 'system.model.failed',
    category: 'system',
    description:
      'An inference model/capability failed to load or errored during execution (self-healing/rollback signal).',
    defaultPriority: 'high',
    pii: 'none',
  },
  // operational lifecycle events (P2-2 G-3) — for monitoring/troubleshooting. These are EventEnvelopes
  // like any other; rules decide what they mean. Distinct from the domain-specific media/device
  // events above (kept for back-compat) — the `system.*` namespace is the canonical monitoring set.
  {
    type: 'system.camera.connected',
    category: 'system',
    description: 'A camera device connected / came online (operational).',
    defaultPriority: 'low',
    pii: 'none',
  },
  {
    type: 'system.camera.disconnected',
    category: 'system',
    description: 'A camera device disconnected / went offline (operational).',
    defaultPriority: 'high',
    pii: 'none',
  },
  {
    type: 'system.stream.started',
    category: 'system',
    description: 'A media stream ingestion worker started producing frames.',
    defaultPriority: 'low',
    pii: 'none',
  },
  {
    type: 'system.stream.stopped',
    category: 'system',
    description: 'A media stream ingestion worker stopped.',
    defaultPriority: 'low',
    pii: 'none',
  },
  {
    type: 'system.stream.reconnected',
    category: 'system',
    description: 'A lost media stream reconnected after backoff.',
    defaultPriority: 'low',
    pii: 'none',
  },
  {
    type: 'system.stream.timeout',
    category: 'system',
    description: 'A media stream timed out awaiting frames.',
    defaultPriority: 'medium',
    pii: 'none',
  },
  {
    type: 'system.recording.started',
    category: 'system',
    description: 'Recording began for a camera stream.',
    defaultPriority: 'info',
    pii: 'none',
  },
  {
    type: 'system.recording.stopped',
    category: 'system',
    description: 'Recording stopped for a camera stream.',
    defaultPriority: 'info',
    pii: 'none',
  },
  {
    type: 'system.model.loaded',
    category: 'system',
    description: 'An inference model/capability finished loading and is READY.',
    defaultPriority: 'info',
    pii: 'none',
  },
  {
    type: 'system.model.unloaded',
    category: 'system',
    description: 'An inference model/capability was unloaded/disposed.',
    defaultPriority: 'info',
    pii: 'none',
  },
  {
    type: 'system.pipeline.started',
    category: 'system',
    description: 'An inference session/pipeline started running for a camera.',
    defaultPriority: 'low',
    pii: 'none',
  },
  {
    type: 'system.pipeline.stopped',
    category: 'system',
    description: 'An inference session/pipeline stopped running.',
    defaultPriority: 'low',
    pii: 'none',
  },
  // perception
  {
    type: 'perception.object.detected',
    category: 'perception',
    description:
      'A generic object of some class was detected in a frame (domain-neutral fallback when a label has no dedicated event type).',
    defaultPriority: 'info',
    pii: 'low',
  },
  {
    type: 'perception.person.detected',
    category: 'perception',
    description: 'A person was detected in a frame.',
    producer: 'perception.person-detection',
    defaultPriority: 'info',
    pii: 'low',
  },
  {
    type: 'perception.vehicle.detected',
    category: 'perception',
    description: 'A vehicle was detected.',
    producer: 'perception.vehicle-detection',
    defaultPriority: 'info',
    pii: 'low',
  },
  {
    type: 'perception.fire.detected',
    category: 'safety',
    description: 'Fire/flame detected (safety-critical).',
    producer: 'perception.fire-smoke',
    defaultPriority: 'critical',
    pii: 'none',
  },
  {
    type: 'perception.smoke.detected',
    category: 'safety',
    description: 'Smoke detected (safety-critical).',
    producer: 'perception.fire-smoke',
    defaultPriority: 'critical',
    pii: 'none',
  },
  {
    type: 'perception.weapon.detected',
    category: 'security',
    description: 'A weapon (firearm/knife) was detected (security-critical).',
    producer: 'perception.weapon-detection',
    defaultPriority: 'critical',
    pii: 'none',
  },
  {
    type: 'perception.face.detected',
    category: 'perception',
    description:
      'A face was detected in a frame (detection only — identity matching is recognition.face.matched).',
    producer: 'perception.face-detection',
    defaultPriority: 'info',
    pii: 'high',
  },
  {
    type: 'perception.pose.detected',
    category: 'perception',
    description:
      'A human body pose/skeleton was estimated (drives fall/fight/behaviour analytics).',
    producer: 'perception.pose-detection',
    defaultPriority: 'info',
    pii: 'low',
  },
  {
    type: 'safety.ppe.violation',
    category: 'safety',
    description:
      'A PPE (personal protective equipment) violation was observed — required gear missing (hard-hat/vest/mask).',
    producer: 'perception.ppe-detection',
    defaultPriority: 'high',
    pii: 'low',
  },
  {
    type: 'recognition.plate.read',
    category: 'perception',
    description: 'A license/number plate was read.',
    producer: 'perception.lpr',
    defaultPriority: 'info',
    pii: 'high',
  },
  {
    type: 'recognition.face.matched',
    category: 'security',
    description: 'A face matched an enrolled identity (policy-gated).',
    producer: 'perception.face-recognition',
    defaultPriority: 'medium',
    pii: 'high',
  },
  // spatial / temporal
  {
    type: 'spatial.zone.entered',
    category: 'perception',
    description: 'A tracked subject entered a zone.',
    producer: 'spatial.zone-detection',
    defaultPriority: 'info',
    pii: 'low',
  },
  {
    type: 'spatial.zone.exited',
    category: 'perception',
    description: 'A tracked subject exited a zone.',
    producer: 'spatial.zone-detection',
    defaultPriority: 'info',
    pii: 'low',
  },
  {
    type: 'spatial.line.crossed',
    category: 'perception',
    description: 'A tracked subject crossed a line (with direction).',
    producer: 'spatial.line-crossing',
    defaultPriority: 'info',
    pii: 'low',
  },
  {
    type: 'temporal.dwell.exceeded',
    category: 'analytics',
    description: 'A subject dwelled in a zone beyond a threshold.',
    defaultPriority: 'low',
    pii: 'low',
  },
  {
    type: 'object.left-behind',
    category: 'security',
    description: 'A static object was left behind by an absent owner.',
    producer: 'object.left-behind',
    defaultPriority: 'medium',
    pii: 'none',
  },
  {
    type: 'object.removed',
    category: 'security',
    description: 'A monitored object was removed.',
    producer: 'object.removed',
    defaultPriority: 'medium',
    pii: 'none',
  },
  // behaviour analytics (higher-order events derived from detections + tracking + pose).
  // Note: `behaviour` is a naming domain, not an event CATEGORY — these map onto the frozen
  // category set (security / safety) so routing/filtering stays stable (see category.ts).
  {
    type: 'behavior.theft.suspected',
    category: 'security',
    description: 'A behaviour pattern consistent with theft/shoplifting was observed (advisory).',
    producer: 'behavior.theft-detection',
    defaultPriority: 'high',
    pii: 'low',
  },
  {
    type: 'behavior.fight.detected',
    category: 'security',
    description: 'A physical altercation / aggressive interaction was detected.',
    producer: 'behavior.fight-detection',
    defaultPriority: 'high',
    pii: 'low',
  },
  {
    type: 'behavior.fall.detected',
    category: 'safety',
    description: 'A person fall was detected (life-safety).',
    producer: 'behavior.fall-detection',
    defaultPriority: 'high',
    pii: 'low',
  },
  {
    type: 'behavior.loitering.detected',
    category: 'security',
    description: 'A subject loitered in an area beyond a behavioural threshold.',
    producer: 'behavior.loitering-detection',
    defaultPriority: 'medium',
    pii: 'low',
  },
  {
    // A perception primitive — a subject was present in a zone designated restricted. The AI runtime
    // never decides "after-hours"/"authorized"; time-of-day + personnel policy are the Rule Engine's.
    type: 'security.intrusion.detected',
    category: 'security',
    description: 'A subject was present in a zone designated as restricted (perception primitive).',
    producer: 'behavior.intrusion-detection',
    defaultPriority: 'high',
    pii: 'low',
  },
  // analytics (derived aggregates/insights over a window; not a single detection)
  {
    type: 'analytics.people.count',
    category: 'analytics',
    description: 'A people-count for a camera/zone over an interval.',
    producer: 'analytics.people-counting',
    defaultPriority: 'info',
    pii: 'low',
  },
  {
    type: 'analytics.queue.length',
    category: 'analytics',
    description: 'The measured length of a queue/line at a monitored point.',
    producer: 'analytics.queue-analytics',
    defaultPriority: 'info',
    pii: 'low',
  },
  {
    type: 'analytics.crowd.density',
    category: 'analytics',
    description: 'The crowd density (subjects per zone) crossed a configured level.',
    producer: 'analytics.crowd',
    defaultPriority: 'low',
    pii: 'low',
  },
  {
    type: 'analytics.occupancy.changed',
    category: 'analytics',
    description: 'The occupancy of a zone crossed a level/threshold.',
    producer: 'analytics.occupancy',
    defaultPriority: 'low',
    pii: 'low',
  },
  // tracking
  {
    type: 'tracking.track.updated',
    category: 'perception',
    description: 'A track position/state was updated.',
    producer: 'perception.tracking',
    defaultPriority: 'info',
    pii: 'low',
  },
  // lifecycle (platform)
  {
    type: 'event.persisted',
    category: 'system',
    description:
      'A normalized event was persisted to the event store and published on the backbone (the signal rules/analytics react to). Emitted by the events context (P1-5).',
    defaultPriority: 'info',
    pii: 'none',
  },
  {
    type: 'rule.matched',
    category: 'system',
    description:
      'A tenant rule matched an event (audit/observability; every match, even below action threshold).',
    defaultPriority: 'info',
    pii: 'none',
  },
  {
    type: 'incident.candidate',
    category: 'system',
    description:
      'A rule match proposes an incident — the automation candidate the alert/workflow engine promotes (P1-7).',
    defaultPriority: 'high',
    pii: 'none',
  },
  {
    type: 'incident.raised',
    category: 'system',
    description:
      'A workflow incident was raised (promoted from a rule candidate) — the signal the Alert Engine reacts to (P1-8).',
    defaultPriority: 'high',
    pii: 'none',
  },
  {
    type: 'incident.acknowledged',
    category: 'system',
    description: 'An operator acknowledged and took ownership of an incident (P1-8).',
    defaultPriority: 'info',
    pii: 'none',
  },
  {
    type: 'incident.resolved',
    category: 'system',
    description: 'An incident was resolved with a resolution note (P1-8).',
    defaultPriority: 'info',
    pii: 'none',
  },
  {
    type: 'incident.closed',
    category: 'system',
    description: 'An incident was closed (terminal; retained for audit) (P1-8).',
    defaultPriority: 'info',
    pii: 'none',
  },
  // notifications (Alert Engine — Notification context, P1-8)
  {
    type: 'notification.sent',
    category: 'system',
    description: 'A notification was handed to a delivery channel transport (P1-8).',
    defaultPriority: 'info',
    pii: 'low',
  },
  {
    type: 'notification.delivered',
    category: 'system',
    description: 'A channel transport confirmed delivery of a notification (P1-8).',
    defaultPriority: 'info',
    pii: 'low',
  },
  {
    type: 'notification.failed',
    category: 'system',
    description: 'A notification exhausted its delivery attempts without success (P1-8).',
    defaultPriority: 'medium',
    pii: 'low',
  },
  {
    type: 'notification.acked',
    category: 'system',
    description: 'A recipient acknowledged a delivered notification (P1-8).',
    defaultPriority: 'info',
    pii: 'low',
  },
];

/** Fast lookup by type. Throws-free: returns undefined if unknown. */
const CATALOG_INDEX = new Map(EVENT_CATALOG.map((e) => [e.type, e] as const));
export function lookupEvent(type: string): EventCatalogEntry | undefined {
  return CATALOG_INDEX.get(type);
}
export function isKnownEventType(type: string): boolean {
  return CATALOG_INDEX.has(type);
}
