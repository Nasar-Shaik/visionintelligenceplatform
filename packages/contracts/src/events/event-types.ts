/**
 * Canonical event-type constants (P2-2 G-3) — the single source of truth for every event type
 * string, grouped by domain. The catalog ([catalog.ts](catalog.ts)) attaches metadata (category,
 * priority, PII, producer) to each; validation ([validation.ts](validation.ts)) looks them up. The
 * Inference Runtime, Rule Engine, Dashboard, Alerts, Incidents, and future clients all bind to these
 * names. Types are DOMAIN-NEUTRAL and additive — add a constant, never rename one (Constitution §7).
 *
 * Naming: `<domain>.<subject>.<predicate>` (kebab segments allowed) — enforced by the `EventType`
 * primitive.
 */

/** Perception — a capability observed something in a frame. */
export const PERCEPTION_EVENTS = {
  objectDetected: 'perception.object.detected',
  personDetected: 'perception.person.detected',
  vehicleDetected: 'perception.vehicle.detected',
  weaponDetected: 'perception.weapon.detected',
  faceDetected: 'perception.face.detected',
  poseDetected: 'perception.pose.detected',
  fireDetected: 'perception.fire.detected',
  smokeDetected: 'perception.smoke.detected',
} as const;

/** Recognition — identity/plate matches (higher PII). */
export const RECOGNITION_EVENTS = {
  plateRead: 'recognition.plate.read',
  faceMatched: 'recognition.face.matched',
} as const;

/** Safety — life-safety / hazard signals. */
export const SAFETY_EVENTS = {
  ppeViolation: 'safety.ppe.violation',
} as const;

/** Behaviour analytics — higher-order events derived from detections + tracking + pose. */
export const BEHAVIOR_EVENTS = {
  theftSuspected: 'behavior.theft.suspected',
  fightDetected: 'behavior.fight.detected',
  fallDetected: 'behavior.fall.detected',
  loiteringDetected: 'behavior.loitering.detected',
} as const;

/**
 * Security — access/presence primitives. `intrusion.detected` is a PERCEPTION primitive (a subject in
 * a restricted-designated zone); business interpretation (after-hours, authorized personnel) is the
 * Rule Engine's, never the AI runtime's.
 */
export const SECURITY_EVENTS = {
  intrusionDetected: 'security.intrusion.detected',
} as const;

/** Analytics — derived aggregates/insights over a window (not a single detection). */
export const ANALYTICS_EVENTS = {
  peopleCount: 'analytics.people.count',
  queueLength: 'analytics.queue.length',
  occupancyChanged: 'analytics.occupancy.changed',
  dwellExceeded: 'temporal.dwell.exceeded',
} as const;

/** Spatial/temporal — zone/line/track events. */
export const SPATIAL_EVENTS = {
  zoneEntered: 'spatial.zone.entered',
  zoneExited: 'spatial.zone.exited',
  lineCrossed: 'spatial.line.crossed',
  trackUpdated: 'tracking.track.updated',
  objectLeftBehind: 'object.left-behind',
  objectRemoved: 'object.removed',
} as const;

/**
 * System — operational lifecycle + health signals for monitoring/troubleshooting (P2-2 G-3 expands
 * this set). These flow through the same EventEnvelope; the runtime/services emit them, and rules
 * decide what they mean — they are NEVER incidents by themselves.
 */
export const SYSTEM_EVENTS = {
  // camera device lifecycle
  cameraConnected: 'system.camera.connected',
  cameraDisconnected: 'system.camera.disconnected',
  // media stream lifecycle
  streamStarted: 'system.stream.started',
  streamStopped: 'system.stream.stopped',
  streamReconnected: 'system.stream.reconnected',
  streamTimeout: 'system.stream.timeout',
  // recording lifecycle
  recordingStarted: 'system.recording.started',
  recordingStopped: 'system.recording.stopped',
  // model lifecycle (inference runtime)
  modelLoaded: 'system.model.loaded',
  modelUnloaded: 'system.model.unloaded',
  modelFailed: 'system.model.failed',
  // pipeline / inference-session lifecycle
  pipelineStarted: 'system.pipeline.started',
  pipelineStopped: 'system.pipeline.stopped',
} as const;

/** Every canonical event-type string, flat. Extend by adding to a group above. */
export const ALL_EVENT_TYPES: readonly string[] = [
  ...Object.values(PERCEPTION_EVENTS),
  ...Object.values(RECOGNITION_EVENTS),
  ...Object.values(SAFETY_EVENTS),
  ...Object.values(BEHAVIOR_EVENTS),
  ...Object.values(SECURITY_EVENTS),
  ...Object.values(ANALYTICS_EVENTS),
  ...Object.values(SPATIAL_EVENTS),
  ...Object.values(SYSTEM_EVENTS),
];
