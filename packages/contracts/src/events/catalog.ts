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

/** PII classification for governance/policy handling (docs/architecture/15, 28). */
export const PiiClass = z.enum(['none', 'low', 'high']);
export type PiiClass = z.infer<typeof PiiClass>;

/** A catalog entry describing one event type. */
export const EventCatalogEntry = z.object({
  type: EventType,
  description: z.string(),
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
    description: 'A tenant was provisioned (org root + admin seeded downstream).',
    defaultPriority: 'high',
    pii: 'none',
  },
  {
    type: 'tenant.activated',
    description: 'A tenant became active.',
    defaultPriority: 'low',
    pii: 'none',
  },
  {
    type: 'tenant.suspended',
    description: 'A tenant was suspended (access denied; data retained).',
    defaultPriority: 'high',
    pii: 'none',
  },
  {
    type: 'tenant.deprovisioned',
    description: 'A tenant was deprovisioned (data purge + token revocation).',
    defaultPriority: 'high',
    pii: 'none',
  },
  {
    type: 'org.node.created',
    description: 'An organizational-hierarchy node was created under a tenant.',
    defaultPriority: 'info',
    pii: 'none',
  },
  // identity / auth (control-plane)
  {
    type: 'user.created',
    description: 'A user was created under a tenant.',
    defaultPriority: 'low',
    pii: 'low',
  },
  {
    type: 'auth.login.succeeded',
    description: 'A principal authenticated successfully.',
    defaultPriority: 'info',
    pii: 'low',
  },
  {
    type: 'auth.token.refreshed',
    description: 'A refresh token was rotated for a new access token.',
    defaultPriority: 'info',
    pii: 'none',
  },
  {
    type: 'auth.refresh.reused',
    description: 'A used/rotated refresh token was replayed — token family revoked (compromise).',
    defaultPriority: 'high',
    pii: 'none',
  },
  {
    type: 'auth.logout',
    description: 'A principal logged out (refresh token/family revoked).',
    defaultPriority: 'low',
    pii: 'none',
  },
  // camera inventory (control-plane; P1-3)
  {
    type: 'camera.registered',
    description: 'A camera was onboarded under a tenant (consumed by media/ingestion).',
    defaultPriority: 'low',
    pii: 'none',
  },
  {
    type: 'camera.updated',
    description: 'A camera’s configuration changed (zone, stream, capture, status, credentials).',
    defaultPriority: 'info',
    pii: 'none',
  },
  {
    type: 'camera.removed',
    description: 'A camera was removed from the inventory (ingestion should stop).',
    defaultPriority: 'low',
    pii: 'none',
  },
  {
    type: 'camera.health.changed',
    description: 'A camera’s observed health transitioned (unknown/online/offline/unhealthy).',
    defaultPriority: 'medium',
    pii: 'none',
  },
  // device / lifecycle
  {
    type: 'device.camera.offline',
    description: 'A camera stopped reporting/heartbeat.',
    defaultPriority: 'high',
    pii: 'none',
  },
  {
    type: 'device.camera.online',
    description: 'A camera resumed reporting.',
    defaultPriority: 'low',
    pii: 'none',
  },
  // perception
  {
    type: 'perception.person.detected',
    description: 'A person was detected in a frame.',
    producer: 'perception.person-detection',
    defaultPriority: 'info',
    pii: 'low',
  },
  {
    type: 'perception.vehicle.detected',
    description: 'A vehicle was detected.',
    producer: 'perception.vehicle-detection',
    defaultPriority: 'info',
    pii: 'low',
  },
  {
    type: 'perception.fire.detected',
    description: 'Fire/flame detected (safety-critical).',
    producer: 'perception.fire-smoke',
    defaultPriority: 'critical',
    pii: 'none',
  },
  {
    type: 'perception.smoke.detected',
    description: 'Smoke detected (safety-critical).',
    producer: 'perception.fire-smoke',
    defaultPriority: 'critical',
    pii: 'none',
  },
  {
    type: 'recognition.plate.read',
    description: 'A license/number plate was read.',
    producer: 'perception.lpr',
    defaultPriority: 'info',
    pii: 'high',
  },
  {
    type: 'recognition.face.matched',
    description: 'A face matched an enrolled identity (policy-gated).',
    producer: 'perception.face-recognition',
    defaultPriority: 'medium',
    pii: 'high',
  },
  // spatial / temporal
  {
    type: 'spatial.zone.entered',
    description: 'A tracked subject entered a zone.',
    producer: 'spatial.zone-detection',
    defaultPriority: 'info',
    pii: 'low',
  },
  {
    type: 'spatial.zone.exited',
    description: 'A tracked subject exited a zone.',
    producer: 'spatial.zone-detection',
    defaultPriority: 'info',
    pii: 'low',
  },
  {
    type: 'spatial.line.crossed',
    description: 'A tracked subject crossed a line (with direction).',
    producer: 'spatial.line-crossing',
    defaultPriority: 'info',
    pii: 'low',
  },
  {
    type: 'temporal.dwell.exceeded',
    description: 'A subject dwelled in a zone beyond a threshold.',
    defaultPriority: 'low',
    pii: 'low',
  },
  {
    type: 'object.left-behind',
    description: 'A static object was left behind by an absent owner.',
    producer: 'object.left-behind',
    defaultPriority: 'medium',
    pii: 'none',
  },
  {
    type: 'object.removed',
    description: 'A monitored object was removed.',
    producer: 'object.removed',
    defaultPriority: 'medium',
    pii: 'none',
  },
  // tracking
  {
    type: 'tracking.track.updated',
    description: 'A track position/state was updated.',
    producer: 'perception.tracking',
    defaultPriority: 'info',
    pii: 'low',
  },
  // lifecycle (platform)
  {
    type: 'incident.raised',
    description: 'A workflow incident was raised from a rule match.',
    defaultPriority: 'high',
    pii: 'none',
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
