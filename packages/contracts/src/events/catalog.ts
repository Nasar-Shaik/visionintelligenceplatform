/**
 * Event catalog — the machine-readable registry of event types (docs/architecture/09 §2).
 * Rule/workflow authors and plugins discover event types here. Adding an event type = adding
 * a versioned catalog entry (additive; never repurpose a field). All types are DOMAIN-NEUTRAL.
 *
 * This seed set covers the foundational perception/spatial/lifecycle events. Compositions,
 * connectors, and plugins register additional types (docs 24, 25, 20).
 */
import { z } from 'zod';
import { EventType, CapabilityId } from '../common/primitives.js';
import { EventPriority } from './priority.js';
import { EventCategory } from './category.js';

/** PII classification for governance/policy handling (docs/architecture/15, 28). */
export const PiiClass = z.enum(['none', 'low', 'high']);
export type PiiClass = z.infer<typeof PiiClass>;

/** A catalog entry describing one event type. */
export const EventCatalogEntry = z.object({
  type: EventType,
  description: z.string(),
  /** Coarse classification for filtering/routing (rules, analytics) — stamped onto every envelope. */
  category: EventCategory,
  /** Capability family that typically produces it (informational). */
  producer: CapabilityId.optional(),
  defaultPriority: EventPriority,
  pii: PiiClass.default('none'),
});
export type EventCatalogEntry = z.infer<typeof EventCatalogEntry>;

/**
 * Seed catalog. Keep entries alphabetically grouped by domain. Extend, never rename.
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
