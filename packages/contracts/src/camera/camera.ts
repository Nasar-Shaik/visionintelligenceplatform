/**
 * Camera (inventory) contracts (Phase 1, P1-3). The Camera context owns cameras as inventory:
 * where each lives (a zone in the tenant-owned org hierarchy), how to connect (protocol + stream
 * URL), a capture profile, health, and **vaulted credentials that never appear in a response**.
 * Grounds: docs/architecture/22-BOUNDED-CONTEXTS.md §3 (Camera context — depends on Tenant),
 * docs/architecture/phase1/CAMERA_ARCHITECTURE.md.
 *
 * The location hierarchy itself (org → … → zone) is owned by the Tenant context (`OrgNode`,
 * P1-1); a camera references its zone by id (`zoneId`) — it does not redefine the tree.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId } from '../common/primitives.js';
import { EvidenceClass } from '../common/evidence.js';

/** Wire protocol used to pull the camera's stream. ONVIF auto-discovery is a later extension. */
export const CameraProtocol = z.enum(['rtsp', 'rtmp']);
export type CameraProtocol = z.infer<typeof CameraProtocol>;

/** Administrative state: whether ingestion should attempt to connect. Distinct from health. */
export const CameraStatus = z.enum(['enabled', 'disabled']);
export type CameraStatus = z.infer<typeof CameraStatus>;

/** Observed connectivity, set by the ingestion/health path (P1-4). Starts `unknown` at onboarding. */
export const CameraHealthStatus = z.enum(['unknown', 'online', 'offline', 'unhealthy']);
export type CameraHealthStatus = z.infer<typeof CameraHealthStatus>;

/** Video codec of the source stream. */
export const CameraCodec = z.enum(['h264', 'h265']);
export type CameraCodec = z.infer<typeof CameraCodec>;

/**
 * A camera's stream URL. Must be an `rtsp(s)://` or `rtmp(s)://` URL and must NOT embed
 * credentials (`user:pass@host`) — credentials are vaulted separately (encrypted at rest) so
 * they never sit in plaintext in a record, log, or response.
 */
export const StreamUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine((u) => /^(rtsps?|rtmps?):\/\//i.test(u), {
    message: 'must be an rtsp:// or rtmp:// URL',
  })
  .refine((u) => !/^[a-z]+:\/\/[^/@]*@/i.test(u), {
    message: 'credentials must not be embedded in the URL — pass them in `credentials`',
  });
export type StreamUrl = z.infer<typeof StreamUrl>;

/** Write-only camera credentials. Accepted on create/update; **never** returned (see `Camera`). */
export const StreamCredentials = z.object({
  username: z.string().min(1).max(255),
  password: z.string().min(1).max(1024),
});
export type StreamCredentials = z.infer<typeof StreamCredentials>;

/** Capture profile: how the stream is expected to be encoded and (optionally) whether it pans/tilts. */
export const CaptureProfile = z.object({
  codec: CameraCodec.optional(),
  /** e.g. "1920x1080". */
  resolution: z
    .string()
    .regex(/^\d{2,5}x\d{2,5}$/, 'must be WIDTHxHEIGHT, e.g. 1920x1080')
    .optional(),
  fps: z.number().int().min(1).max(120).optional(),
  ptz: z.boolean().default(false),
});
export type CaptureProfile = z.infer<typeof CaptureProfile>;

/** Camera health snapshot. Populated by the ingestion/health path; `unknown` until first checked. */
export const CameraHealth = z.object({
  status: CameraHealthStatus,
  lastCheckedAt: IsoDateTime.optional(),
  detail: z.string().max(500).optional(),
});
export type CameraHealth = z.infer<typeof CameraHealth>;

/**
 * One named stream a camera publishes (AI-5c). Real devices expose several — a high-resolution
 * `main` for recording and a low-resolution `sub` for analysis — and choosing the right one is the
 * single cheapest performance decision in the platform: analyzing a 4K main stream when a 640×360
 * sub-stream would do wastes decode and inference budget on every frame.
 */
export const CameraStreamProfile = z.object({
  /** Device-side profile name, e.g. `main`, `sub`, `Profile_1`. */
  name: z.string().min(1).max(100),
  codec: CameraCodec.optional(),
  /** WIDTHxHEIGHT, e.g. "640x360". */
  resolution: z
    .string()
    .regex(/^\d{2,5}x\d{2,5}$/, 'must be WIDTHxHEIGHT, e.g. 1920x1080')
    .optional(),
  fps: z.number().int().min(1).max(120).optional(),
  /** Path/suffix to reach this profile, relative to the camera's stream URL. Never a full credentialed URL. */
  path: z.string().max(500).optional(),
  /** Whether this profile is the one the runtime should analyze by default. */
  preferredForAnalysis: z.boolean().default(false),
});
export type CameraStreamProfile = z.infer<typeof CameraStreamProfile>;

/**
 * What a camera/stream supports (P2-2 G-1; extended AI-5c). Declared at onboarding — defaults are
 * derived from the protocol + capture profile — and editable by an operator; later populated by
 * discovery/ONVIF. Drives the console's Live Monitoring / PTZ affordances without decoding the stream.
 *
 * **The runtime CONSUMES this instead of probing the device** (Architect AI-5b rec 1). Probing a
 * camera to learn its codec/resolution/fps costs a connection and a decode every time a session
 * starts; capabilities are declared once and read thereafter, so N sessions across a restart cost
 * zero probes. Everything here is descriptive — it never changes perception behavior.
 */
export const CameraCapabilities = z.object({
  /** Pan / tilt / zoom controllable. */
  ptz: z.boolean().default(false),
  /** The stream carries an audio track. */
  audio: z.boolean().default(false),
  /** A still snapshot can be pulled. */
  snapshot: z.boolean().default(true),
  /** Codecs the source is known to emit. */
  codecs: z.array(CameraCodec).default([]),
  /** Resolutions the source is known to emit (WIDTHxHEIGHT). */
  resolutions: z
    .array(z.string().regex(/^\d{2,5}x\d{2,5}$/, 'must be WIDTHxHEIGHT'))
    .max(20)
    .default([]),
  /** Transports the camera can be reached on. */
  protocols: z.array(CameraProtocol).default([]),
  /**
   * Frame rates the source can emit, as an inclusive range (AI-5c). The runtime clamps its requested
   * sampling FPS into this range rather than asking a device for a rate it cannot produce.
   */
  fpsRange: z
    .object({ min: z.number().int().min(1).max(120), max: z.number().int().min(1).max(120) })
    .refine((r) => r.max >= r.min, { message: 'fpsRange.max must be >= fpsRange.min' })
    .optional(),
  /** Named streams the device publishes (main/sub/…). Empty when the device has only one. */
  streamProfiles: z.array(CameraStreamProfile).max(10).default([]),
  /** ONVIF is reachable on this device (discovery/PTZ/profile enumeration). */
  onvif: z.boolean().default(false),
  /**
   * The device can publish an ONVIF metadata stream (analytics/events alongside video) — AI-5e
   * discovery populates it. Additive and descriptive: the runtime does not consume the metadata
   * stream today, and recording that a device *offers* one is what lets that decision be made later
   * from an inventory rather than by re-walking every site.
   */
  metadataStream: z.boolean().default(false),
  /** When the capabilities were last confirmed against the device — staleness is an operator signal. */
  discoveredAt: IsoDateTime.optional(),
});
export type CameraCapabilities = z.infer<typeof CameraCapabilities>;

/**
 * Operator / device metadata (P2-2 G-1) — descriptive, non-connection fields for grouping, search,
 * and audit. Distinct from the capture/connection config; never affects ingestion.
 */
export const CameraMetadata = z.object({
  manufacturer: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  firmware: z.string().max(100).optional(),
  serialNumber: z.string().max(200).optional(),
  /** Human location description (the structural location is `zoneId`). */
  location: z.string().max(500).optional(),
  /** Free-form operator tags for grouping/filtering. */
  tags: z.array(z.string().min(1).max(50)).max(50).default([]),
  notes: z.string().max(2000).optional(),
  /**
   * Organisational owner of the camera (P-8 Phase 6, Architect rec 4). Cuts **across** locations —
   * a department can span floors and buildings, which is exactly why it is not a hierarchy node.
   */
  department: z.string().max(200).optional(),
  /**
   * Operational importance, for future bulk assignment and targeting (P-8 Phase 6, Architect rec 4).
   *
   * ⚠️ Descriptive only. Nothing in the platform reads this to make a decision today — placement is
   * capacity- and health-driven, and a priority that silently changed which camera got AI would be a
   * scheduling policy nobody reviewed.
   */
  priority: z.enum(['critical', 'high', 'normal', 'low']).optional(),
});
export type CameraMetadata = z.infer<typeof CameraMetadata>;

/*
 * ⚠️ **Building · Floor · Zone · Store are deliberately NOT metadata fields**, though the Architect's
 * recommendation listed them beside `department` and `priority`.
 *
 * They are already modelled — with ancestry, archival and referential permanence — by the Location
 * Hierarchy (`OrgNodeType`: `org · region · country · branch · site · building · floor · zone`), and
 * a camera already names its `zoneId`. Copying them here would give the platform two answers to
 * "where is this camera", and the copy is the one that goes stale after a site is reorganised.
 * `department` and `priority` are added because they are the two the hierarchy genuinely does not
 * express: one cuts across locations, the other is a property of the device's job.
 */

// ---------------------------------------------------------------------------------------------
// Camera lifecycle, identity and operational health (P-2)
// ---------------------------------------------------------------------------------------------

/**
 * The operational state machine of a **managed** camera (Architect P-1 rec 1).
 *
 * The split that makes this work: the first three states are things the platform can *declare* from
 * configuration, and the next four are things it can only *observe*. A camera is not `connected`
 * because an operator ticked a box; it is `connected` because something read a frame off it. That is
 * the AI-5e evidence rule (`EvidenceClass`) applied to devices instead of capabilities, and it is
 * enforced in the transition function, not in a comment (`services/camera` `domain/lifecycle.ts`).
 *
 * - `discovered` — the device is known to exist. Nothing about it has been verified.
 * - `validated` — its configuration passes the deterministic checks (scheme, protocol, credentials).
 * - `configured` — it has an operational configuration: a zone, a name, a capture profile.
 * - `connected` — **measured**: a probe against the physical device read frames from it.
 * - `monitoring` — **measured**: an analysis session is consuming it.
 * - `degraded` — **measured**: reachable but failing — frames stalled, latency high, auth rejected.
 * - `offline` — **measured**: it cannot be reached at all.
 * - `retired` — administrative: decommissioned. The record and its evidence are kept; it is excluded
 *   from operations. Distinct from deletion, which destroys the history an incident might need.
 */
export const CameraLifecycleState = z.enum([
  'discovered',
  'validated',
  'configured',
  'connected',
  'monitoring',
  'degraded',
  'offline',
  'retired',
]);
export type CameraLifecycleState = z.infer<typeof CameraLifecycleState>;

/**
 * How the platform knows a camera is in its current state.
 *
 * - `declared` — from the configuration an operator supplied. Proves intent, not reality.
 * - `validated` — from deterministic checks over that configuration. Still no device was contacted.
 * - `measured` — something talked to the device and observed the result. The only class that may
 *   enter `connected` / `monitoring` / `degraded` / `offline`.
 * - `administrative` — a human decision (retire, reinstate). Never claims anything about the device.
 */
export const LifecycleEvidence = z.enum(['declared', 'validated', 'measured', 'administrative']);
export type LifecycleEvidence = z.infer<typeof LifecycleEvidence>;

/** A camera's current lifecycle position. The history lives in `Camera.timeline` — one record, not two. */
export const CameraLifecycle = z.object({
  state: CameraLifecycleState,
  since: IsoDateTime,
  evidence: LifecycleEvidence,
  reason: z.string().max(300).optional(),
});
export type CameraLifecycle = z.infer<typeof CameraLifecycle>;

/**
 * What happened to a camera. Broader than a state change, because the things that explain a state
 * change are usually not themselves state changes: firmware moved, credentials were rotated,
 * capabilities were re-read. Troubleshooting means reading those interleaved, in order.
 *
 * Additive by construction (Architect P-2 rec 8): PTZ presets, snapshots, SD-card status and
 * firmware upgrades all become new `kind` values on this enum, with no shape change anywhere else.
 */
export const CameraTimelineEventKind = z.enum([
  'state-changed',
  'identity-changed',
  'firmware-changed',
  'capability-refreshed',
  'credentials-updated',
  'configuration-updated',
  'probe-succeeded',
  'probe-failed',
  'recovered',
]);
export type CameraTimelineEventKind = z.infer<typeof CameraTimelineEventKind>;

/**
 * One entry in a camera's operational timeline (Architect P-2 rec 4), modelled on the runtime's
 * DiagnosticsJournal: append-only, bounded, and carrying the evidence class behind each claim.
 */
/**
 * Why a timeline entry happened — typed, not prose (P-2.1, Architect rec 7).
 *
 * `detail` stays for the human sentence, but the *reason* has to be machine-readable or the timeline
 * cannot be filtered, counted or trended. "Capability refresh — reason: firmware updated" answers an
 * investigation; "capabilities refreshed" does not.
 */
export const TimelineReasonCode = z.enum([
  'onboarded',
  'hardware-evidence',
  'operator-action',
  'firmware-updated',
  'cache-expired',
  'cache-version-changed',
  'authentication-failure',
  'device-unreachable',
  'stream-unavailable',
  'address-changed',
  'credentials-rotated',
  'configuration-changed',
  'derived',
]);
export type TimelineReasonCode = z.infer<typeof TimelineReasonCode>;

export const CameraTimelineEntry = z.object({
  at: IsoDateTime,
  kind: CameraTimelineEventKind,
  evidence: LifecycleEvidence,
  /** The machine-readable reason. Generic messages are what this field exists to eliminate. */
  reasonCode: TimelineReasonCode,
  /**
   * Provenance of the measurement behind this entry, when there was one (P-2.1 rec 4). Lets a stored
   * timeline be compared against a later probe without keeping every full report.
   */
  probeVersion: z.string().max(20).optional(),
  correlationId: z.string().max(120).optional(),
  /**
   * Wall-clock cost of the operation this entry records, when it had one (P-2.2, Architect rec 8).
   *
   * Carried on the timeline rather than in a metrics store because the timeline is already the
   * append-only record of what happened — a parallel store of the same events keyed by the same
   * timestamps would be two sources of truth for one fact, and they would diverge.
   */
  durationMs: z.number().nonnegative().optional(),
  /** The immutable probe report behind this entry, when one exists (P-2.2, Architect rec 1). */
  probeId: z.string().max(120).optional(),
  /** Groups the entries of one logical change — a refresh and everything it moved (P-2.3 rec 5). */
  changeSetId: z.string().max(120).optional(),
  /** Present on `state-changed` — the transition this entry records. */
  from: CameraLifecycleState.optional(),
  to: CameraLifecycleState.optional(),
  /** Why, in the words an operator needs. Never carries credentials. */
  detail: z.string().max(300),
});
export type CameraTimelineEntry = z.infer<typeof CameraTimelineEntry>;

/**
 * A camera's bounded operational timeline. **Bounded at 50 deliberately**: a camera flapping between
 * `connected` and `offline` every thirty seconds would otherwise grow its own document without
 * limit, and the fifty most recent entries answer the question an operator is actually asking
 * ("what has been happening to this camera?") as well as fifty thousand would. Trends over longer
 * windows are what `CameraHealthSummary` is for.
 *
 * Most recent last.
 */
export const CameraTimeline = z.array(CameraTimelineEntry).max(50);
export type CameraTimeline = z.infer<typeof CameraTimeline>;

/**
 * A camera's **stable device identity**, independent of where it currently sits on the network
 * (Architect P-1 rec 7, P-2 rec 1). IP addresses change — DHCP leases expire, sites get re-subnetted,
 * a device is moved to another VLAN — and none of that makes it a different camera.
 *
 * The platform keeps **three identities for one camera**, and conflating any two of them is a bug:
 *
 * | Identity    | Where it lives                        | Changes?                        |
 * | ----------- | ------------------------------------- | ------------------------------- |
 * | Device      | this shape (`onvifUuid`/serial/MAC)   | **never** — it is the hardware  |
 * | Network     | `streamUrl`, `lastKnownAddress`       | freely — DHCP, re-subnetting    |
 * | Operational | `tenantId`, `zoneId`, `name`          | when the estate is reorganised  |
 *
 * Every field is optional because devices vary in what they will tell you, and identity is whatever
 * is strongest among them (`onvifUuid` > `serialNumber` > `macAddress`). `lastKnownAddress` sits here
 * as a convenience for finding the device and is deliberately **not** part of identity — it is the
 * field expected to change.
 */
export const CameraDeviceIdentity = z.object({
  /** ONVIF endpoint reference, e.g. `urn:uuid:...`. The strongest identifier a device offers. */
  onvifUuid: z.string().max(200).optional(),
  serialNumber: z.string().max(200).optional(),
  /** Normalised lowercase, colon-separated. */
  macAddress: z
    .string()
    .regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/, 'must be a lowercase colon-separated MAC address')
    .optional(),
  hardwareId: z.string().max(200).optional(),
  /** Where it was last seen. Descriptive only — identity never depends on it. */
  lastKnownAddress: z.string().max(200).optional(),
  /** When the identity was last confirmed against the device. */
  confirmedAt: IsoDateTime.optional(),
});
export type CameraDeviceIdentity = z.infer<typeof CameraDeviceIdentity>;

/**
 * Which identifying attribute changed. Network fields are here alongside device fields deliberately:
 * an operator investigating "when did this become a different camera?" needs both, and separating
 * them into two histories would make the one question they are asking need two lookups.
 */
export const IdentityAttribute = z.enum([
  'onvifUuid',
  'serialNumber',
  'macAddress',
  'hardwareId',
  'address',
  'streamUrl',
  'firmware',
]);
export type IdentityAttribute = z.infer<typeof IdentityAttribute>;

/**
 * One recorded change to a camera's identity (P-2.1, Architect P-2 rec 1).
 *
 * **Identity is appended to, never overwritten.** A camera whose serial number changed is either a
 * replaced unit somebody swapped in without telling anyone, or a re-used record — and both are worth
 * knowing about months later. Overwriting the field silently makes an estate that was quietly
 * re-cabled indistinguishable from one that was not.
 */
export const CameraIdentityChange = z.object({
  at: IsoDateTime,
  attribute: IdentityAttribute,
  /** Absent when the attribute was previously unknown — first observation, not a change. */
  from: z.string().max(200).optional(),
  to: z.string().max(200),
  /** How the change was observed. */
  source: z.enum(['discovery', 'probe', 'operator']),
});
export type CameraIdentityChange = z.infer<typeof CameraIdentityChange>;

/**
 * A camera's identity history, most recent last. Bounded at 30: an identifier that has changed thirty
 * times is telling you something the thirty-first entry will not add to.
 */
export const CameraIdentityHistory = z.array(CameraIdentityChange).max(30);
export type CameraIdentityHistory = z.infer<typeof CameraIdentityHistory>;

/**
 * How sure the platform is that a discovered device is a particular managed camera (P-2.1, rec 3).
 *
 * - `high` — an ONVIF UUID or a serial number matched. These are assigned by the device.
 * - `medium` — a MAC matched. Identifies the interface, which is usually but not always the unit.
 * - `low` — only the network address matched. Addresses are reassigned; this is a guess with a
 *   plausible story attached.
 * - `unknown` — the device offered no reliable identifier at all.
 *
 * **Identity is never silently assumed.** A `low` match is shown as a low match, because an
 * installer merging two cameras on the strength of a recycled DHCP lease is a worse outcome than
 * onboarding one twice.
 */
export const IdentityConfidence = z.enum(['high', 'medium', 'low', 'unknown']);
export type IdentityConfidence = z.infer<typeof IdentityConfidence>;

/** Whether the device accepted the credentials it was offered. `unknown` until something tried. */
export const CameraAuthState = z.enum(['unknown', 'ok', 'failed']);
export type CameraAuthState = z.infer<typeof CameraAuthState>;

/** What produced an operational-health observation. Determines what the observation may claim. */
export const HealthObservationSource = z.enum([
  /** Deterministic checks over stored configuration. Contacts nothing; can never prove a stream. */
  'configuration',
  /** A direct probe of the stream. The only source that can report frames. */
  'stream-probe',
  /** An ONVIF query — device information, firmware, uptime. Proves the device, not the stream. */
  'onvif',
  /** A running ingestion/analysis session reporting what it is actually receiving. */
  'ingestion',
]);
export type HealthObservationSource = z.infer<typeof HealthObservationSource>;

/**
 * **Camera health, separate from AI session health** (Architect P-1 rec 2).
 *
 * These are two different questions that a single "health" field kept conflating: *is the device
 * working* versus *is analysis working*. A camera can be perfectly healthy while a session on it has
 * crashed, and a session can be running happily on a camera that has been serving the same frozen
 * frame for an hour. The AI runtime **consumes** this; it does not own it.
 *
 * Every measured field is optional and means "not observed" when absent — never `false`, never `0`.
 * A dashboard that renders an unmeasured latency as `0 ms` is claiming a measurement it does not
 * have, which is the same failure as certifying hardware from a simulation.
 */
export const CameraOperationalHealth = z.object({
  observedAt: IsoDateTime,
  source: HealthObservationSource,
  /** The class of evidence behind this observation — a simulated probe never proves a real device. */
  evidenceClass: EvidenceClass,
  /** The device answered at all (TCP/ONVIF). Absent = not attempted. */
  reachable: z.boolean().optional(),
  /** Frames were actually decoded from the stream. Absent = nothing tried to read frames. */
  streamAvailable: z.boolean().optional(),
  /** When a frame was last seen. The signal that catches a frozen stream a ping cannot. */
  lastFrameAt: IsoDateTime.optional(),
  /** Time to first frame, milliseconds — what an installer feels as "slow to load". */
  rtspLatencyMs: z.number().nonnegative().optional(),
  onvifAvailable: z.boolean().optional(),
  authentication: CameraAuthState.default('unknown'),
  /** Firmware as the device reported it — the trigger for a capability re-read (rec 3). */
  firmware: z.string().max(100).optional(),
  /** Device uptime in seconds. A camera that reboots nightly is a different problem from a flaky one. */
  uptimeSeconds: z.number().int().nonnegative().optional(),
  /** Measured frame rate over the observation window. */
  fps: z.number().nonnegative().optional(),
  /** Measured resolution (WIDTHxHEIGHT) — catches a device silently serving a different profile. */
  resolution: z
    .string()
    .regex(/^\d{2,5}x\d{2,5}$/, 'must be WIDTHxHEIGHT')
    .optional(),
  /** Human explanation, especially of a failure. */
  detail: z.string().max(500).optional(),
});
export type CameraOperationalHealth = z.infer<typeof CameraOperationalHealth>;

/** Why a capability read did or did not go back to the device. */
export const CapabilityRefreshReason = z.enum([
  /** Never confirmed against the device — everything on file is derived or declared. */
  'never-discovered',
  /** The device reports different firmware than when capabilities were last read. */
  'firmware-changed',
  /** Older than the cache window. */
  'stale',
  /** An operator asked for it explicitly. */
  'forced',
  /** Served from cache — the device was not contacted. */
  'cached',
]);
export type CapabilityRefreshReason = z.infer<typeof CapabilityRefreshReason>;

/**
 * Provenance of what the platform believes a camera can do (Architect P-2 rec 2).
 *
 * Capabilities are **cached, not re-queried**: an ONVIF negotiation is several round trips, and a
 * device asked for its profiles on every session start is a device that will eventually stop
 * answering. This shape is what makes "only when necessary" decidable — without the firmware the
 * capabilities were read against, "has anything changed?" is unanswerable and the only safe
 * behaviour left is to re-query every time, which is the thing being avoided.
 *
 * Kept beside `CameraCapabilities` rather than inside it: capabilities describe the *device*, this
 * describes the platform's *knowledge* of the device, and merging the two is how a cache-control
 * field ends up being sent to a camera as if it were a setting.
 */
export const CapabilityCache = z.object({
  /**
   * Schema version of the cached capability payload. Bumped when the shape of what discovery
   * extracts changes — a cache filled by an older extractor is stale even if the device has not
   * moved, and without this the platform cannot tell those two cases apart.
   */
  cacheVersion: z.number().int().min(1).default(1),
  /** Firmware the capabilities were read against — the trigger for an automatic re-read. */
  firmware: z.string().max(100).optional(),
  /** When capabilities were first confirmed against the device. */
  discoveredAt: IsoDateTime.optional(),
  /** When the device was last contacted about them (successfully or not). */
  lastRefreshedAt: IsoDateTime.optional(),
  /** Why the last read happened. */
  refreshReason: CapabilityRefreshReason.optional(),
  /** How many times the device has been re-queried — a signal in itself if it climbs. */
  refreshCount: z.number().int().nonnegative().default(0),
  /**
   * Where the current capabilities came from. `declared` means an operator or an onboarding default
   * supplied them and no device has ever confirmed them — which is exactly the case an operator
   * reading a capability list needs to be able to distinguish from a device-confirmed one.
   */
  source: z
    .enum(['declared', 'discovery', 'onvif-directed', 'operator', 'probe'])
    .default('declared'),
  /**
   * How much the cached capabilities can be trusted right now (P-2.1, Architect rec 6). Derived from
   * age against the cache window, never stored stale — `unknown` means no device has ever confirmed
   * them, which is materially different from `expired` (confirmed once, a long time ago).
   */
  freshness: z.enum(['fresh', 'aging', 'expired', 'unknown']).default('unknown'),
});
export type CapabilityCache = z.infer<typeof CapabilityCache>;

/**
 * Whether the platform has actually got this camera working under a given condition (P-2.2, rec 5).
 *
 * The three values are deliberately the same vocabulary the device compatibility registry uses
 * (`ai/inference/camera_registry.py`), and they are earned the same way — **from measured evidence,
 * never from a version number**. `pending-validation` is the honest default and is where a row stays
 * until hardware says otherwise.
 */
export const CompatibilityStatus = z.enum(['supported', 'pending-validation', 'unsupported']);
export type CompatibilityStatus = z.infer<typeof CompatibilityStatus>;

/**
 * What a compatibility row is *about* (P-2.2, Architect rec 5).
 *
 * Firmware alone is not enough. A camera that broke after a runtime upgrade, a camera that works on
 * H.264 and stalls on H.265, and a camera that works over RTSP and fails over the ONVIF PullPoint
 * provider are three real support cases, and a firmware-only register files all three under the same
 * unchanged version string.
 */
export const CompatibilityDimension = z.enum([
  'firmware',
  'runtime-version',
  'onvif-version',
  'codec',
  'provider',
  'edge-profile',
]);
export type CompatibilityDimension = z.infer<typeof CompatibilityDimension>;

/**
 * One condition this camera has run under, and what happened (P-2.2, Architect rec 5).
 *
 * **Only ever presenting the latest status is exactly what this must not do.** A camera that worked
 * on V5.7.3, worked on V5.7.9 and has failed on every probe since V5.8.0 is telling a story that a
 * single current-status field erases — and the story *is* the diagnosis. A row per (dimension,
 * value) is what turns "this camera is broken" into "this camera broke when it was upgraded".
 *
 * **Older rows are never overwritten and never removed.** The counters accumulate, but the row for a
 * firmware the camera has long since moved off stays exactly as it was left.
 *
 * `unsupported` is claimed narrowly: only a device-side failure under hardware evidence earns it. A
 * DNS, TCP or credential failure says nothing whatsoever about a firmware or a codec, and letting
 * those mark one unsupported would blame a vendor for a wrong password.
 */
export const CompatibilityRecord = z.object({
  dimension: CompatibilityDimension,
  /** The observed value — `V5.7.3`, `h265`, `rtsp`, `0.1.0`. */
  value: z.string().min(1).max(120),
  status: CompatibilityStatus,
  firstSeenAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  /** What the status rests on. Below `hardware` nothing may be claimed beyond `pending-validation`. */
  evidenceClass: EvidenceClass,
  /** Hardware probes under this condition that read frames. */
  successfulProbes: z.number().int().nonnegative().default(0),
  /** Hardware probes under this condition that failed for a device-side reason. */
  failedProbes: z.number().int().nonnegative().default(0),
  /** The most recent probe report behind this row — the evidence, addressable. */
  lastProbeId: z.string().max(120).optional(),
  detail: z.string().max(300).optional(),
});
export type CompatibilityRecord = z.infer<typeof CompatibilityRecord>;

/**
 * A camera's compatibility history, oldest first. Bounded at 60 — six dimensions with ten observed
 * values each is already a longer record than any camera's story needs.
 */
export const CameraCompatibilityHistory = z.array(CompatibilityRecord).max(60);
export type CameraCompatibilityHistory = z.infer<typeof CameraCompatibilityHistory>;

/**
 * A camera as persisted/returned. Tenant + zone scoped. Credentials are NOT present — only
 * `hasCredentials` reveals whether any are vaulted (Law 5 isolation + secret-safety).
 */
export const Camera = z.object({
  id: z.string().min(1),
  tenantId: TenantId,
  /** The org-hierarchy node (typically a `zone` or `site`) this camera belongs to (P1-1 `OrgNode`). */
  zoneId: z.string().min(1),
  name: z.string().min(1).max(200),
  protocol: CameraProtocol,
  streamUrl: StreamUrl,
  status: CameraStatus,
  capture: CaptureProfile,
  health: CameraHealth,
  /** What the camera supports (P2-2 G-1). Derived at onboarding; operator- and discovery-editable. */
  capabilities: CameraCapabilities,
  /** Operator/device metadata (P2-2 G-1). */
  metadata: CameraMetadata,
  /**
   * Operational state (P-2). Required, and derived for pre-P-2 records rather than left optional:
   * a state machine every consumer has to null-check is a state machine nobody relies on.
   */
  lifecycle: CameraLifecycle,
  /** Bounded operational history (P-2) — state changes, firmware, capability reads, probes. */
  timeline: CameraTimeline.default([]),
  /** Stable device identity (P-2). Absent until a device has told the platform who it is. */
  identity: CameraDeviceIdentity.optional(),
  /**
   * Append-only record of every identity change (P-2.1). Answers "when did this camera become a
   * different device?", which overwriting the identity in place makes permanently unanswerable.
   */
  identityHistory: CameraIdentityHistory.default([]),
  /** Provenance of the cached capabilities (P-2) — what they were read against, and when. */
  capabilityCache: CapabilityCache.optional(),
  /**
   * Last measured device health (P-2). Absent means **nothing has ever probed this camera** — which
   * is different from, and must never be rendered as, a camera that was probed and found offline.
   */
  operational: CameraOperationalHealth.optional(),
  /**
   * Compatibility history (P-2.2). Every firmware, runtime version, codec and provider this camera
   * has run under, with what was measured for each — never collapsed to the current one.
   */
  compatibility: CameraCompatibilityHistory.default([]),
  /**
   * How many probes have ever been run against this camera (P-2.2). Monotonic, and deliberately
   * distinct from the number of reports still retained: it is what lets the console say "showing 20
   * of 143" instead of implying the archive is complete.
   */
  probeCount: z.number().int().nonnegative().default(0),
  hasCredentials: z.boolean(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Camera = z.infer<typeof Camera>;

/** Input to onboard a camera (server assigns id/status/health/timestamps). */
export const CreateCameraInput = z
  .object({
    zoneId: z.string().min(1),
    name: z.string().min(1).max(200),
    protocol: CameraProtocol,
    streamUrl: StreamUrl,
    credentials: StreamCredentials.optional(),
    capture: CaptureProfile.optional(),
    /** Operator/device metadata (P2-2 G-1). */
    metadata: CameraMetadata.optional(),
    /** Declared capabilities (P2-2 G-1). Omit to derive defaults from protocol + capture. */
    capabilities: CameraCapabilities.optional(),
    /**
     * Stable device identity (P-2), carried through from discovery. Without this the platform has
     * no way to recognise the camera after its address changes, and the next scan offers the same
     * physical device as a new one.
     */
    identity: CameraDeviceIdentity.optional(),
  })
  .refine((c) => c.streamUrl.toLowerCase().startsWith(c.protocol), {
    message: 'streamUrl scheme must match protocol',
    path: ['streamUrl'],
  });
export type CreateCameraInput = z.infer<typeof CreateCameraInput>;

/**
 * Input to update a camera. Protocol is immutable (changing transport ≈ re-onboarding). At least
 * one field is required. Supplying `credentials` re-vaults them; the service verifies a new
 * `streamUrl`'s scheme against the stored protocol.
 */
export const UpdateCameraInput = z
  .object({
    name: z.string().min(1).max(200).optional(),
    zoneId: z.string().min(1).optional(),
    streamUrl: StreamUrl.optional(),
    status: CameraStatus.optional(),
    credentials: StreamCredentials.optional(),
    capture: CaptureProfile.optional(),
    /** Replace operator/device metadata (P2-2 G-1). */
    metadata: CameraMetadata.optional(),
    /** Replace declared capabilities (P2-2 G-1). */
    capabilities: CameraCapabilities.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'at least one field is required',
  });
export type UpdateCameraInput = z.infer<typeof UpdateCameraInput>;

/** Maximum cameras returned by one list request. */
export const CAMERA_PAGE_LIMIT = 500;

/** Maximum zones one list request may filter by — a subtree wider than this is filtered further up. */
export const CAMERA_ZONE_FILTER_LIMIT = 200;

/**
 * A bounded camera query (P-3).
 *
 * `zoneIds` is how the estate reaches the inventory **without either side learning the other's
 * model**. The hierarchy is owned by the Tenant context and the Camera Service must not traverse it
 * (`docs/architecture/PLATFORM_BOUNDARIES.md` rule 4): asking for "every camera under this site"
 * therefore resolves the subtree where the tree lives, and arrives here as a set of zone ids — a
 * filter, not a hierarchy. The Camera Service still does not know what a site is, and that is the
 * property worth keeping.
 */
export const CameraQuery = z.object({
  zoneIds: z.array(z.string().min(1)).max(CAMERA_ZONE_FILTER_LIMIT).optional(),
  status: CameraStatus.optional(),
  lifecycle: CameraLifecycleState.optional(),
  /** Case-insensitive substring match on the camera name. */
  search: z.string().min(1).max(200).optional(),
  limit: z.number().int().positive().max(CAMERA_PAGE_LIMIT).default(CAMERA_PAGE_LIMIT),
  cursor: z.string().min(1).optional(),
});
export type CameraQuery = z.infer<typeof CameraQuery>;

/** One page of cameras. `nextCursor` is absent when the page is the last one. */
export const CameraPage = z.object({
  cameras: z.array(Camera),
  nextCursor: z.string().min(1).optional(),
});
export type CameraPage = z.infer<typeof CameraPage>;

/** Response of `GET /cameras/:id/health`. */
export const CameraHealthReport = CameraHealth.extend({
  cameraId: z.string().min(1),
});
export type CameraHealthReport = z.infer<typeof CameraHealthReport>;

/**
 * Input to ONVIF/network discovery (P-1). Discovery is a **WS-Discovery multicast probe**, so it
 * finds whatever answers on the local segment; `subnet` is advisory metadata recorded on the result,
 * not a scan range, because multicast does not cross a router and pretending otherwise would make an
 * installer think the tool was broken when the real problem is their VLAN.
 */
export const DiscoverCamerasInput = z.object({
  /** The segment the probe was run on, for the record. Multicast does not cross a router. */
  subnet: z.string().max(64).optional(),
  /** How long to listen for answers. Devices reply within a second or two, or not at all. */
  timeoutSeconds: z.number().min(1).max(30).default(3),
});
export type DiscoverCamerasInput = z.infer<typeof DiscoverCamerasInput>;

/**
 * A device found on the network but **not yet onboarded** (P-1). Deliberately a distinct shape from
 * `Camera`: a discovered device has no tenant, no id, no zone and no credentials — it is a
 * *candidate*, and giving it the same type as a persisted camera is how a UI ends up implying the
 * platform is already watching something it has never connected to.
 */
export const DiscoveredCamera = z.object({
  /** ONVIF device service address the probe answered from, e.g. `http://10.0.0.64/onvif/device_service`. */
  endpoint: z.string().min(1).max(500),
  /** Network address parsed from the endpoint — what an installer recognises on their switch. */
  address: z.string().max(200).optional(),
  /** Manufacturer / model / firmware / serial as the device reported them. */
  metadata: CameraMetadata,
  /** Everything discovery negotiated: profiles, codecs, fps range, PTZ, audio, metadata stream. */
  capabilities: CameraCapabilities,
  /**
   * Stream URL to onboard with, derived from the device's own `preferredForAnalysis` profile.
   * **Never carries credentials** — devices routinely return a URI with the password embedded, and
   * that is stripped before it reaches this field (`StreamUrl` would reject it anyway).
   */
  suggestedStreamUrl: StreamUrl.optional(),
  /** Slug matching the compatibility registry, e.g. `hikvision-ds-2cd2143g2`. */
  registryId: z.string().max(120).optional(),
  /**
   * True when a camera in this tenant already uses this device's stream URL. The console shows these
   * greyed rather than hiding them: an installer re-scanning a site needs to see that the four
   * cameras missing from the list are the four already onboarded, not four that failed to answer.
   */
  alreadyOnboarded: z.boolean().default(false),
  /** Id of the existing camera, when `alreadyOnboarded`. */
  cameraId: z.string().min(1).optional(),
  /** How the match was made. `low` and `unknown` must be shown as such, never silently accepted. */
  identityConfidence: IdentityConfidence.default('unknown'),
  /** Stable identity as the device reported it (P-2) — how it is recognised after its IP changes. */
  identity: CameraDeviceIdentity.optional(),
  /**
   * True when this device was matched to an existing camera **by identity** while its stream URL no
   * longer matches (P-2). This is the DHCP case, and it is the whole reason identity exists: without
   * it a re-scan after a lease renewal shows a duplicate candidate and an installer onboards the same
   * physical camera twice. With it, the console can offer to update the address instead.
   */
  addressChanged: z.boolean().default(false),
  /** Why negotiation was incomplete, when it was — bad credentials, ONVIF disabled, a partial reply. */
  warning: z.string().max(500).optional(),
});
export type DiscoveredCamera = z.infer<typeof DiscoveredCamera>;

/** Result of a discovery probe (P-1). */
export const DiscoverCamerasResult = z.object({
  devices: z.array(DiscoveredCamera).default([]),
  /** How long the probe actually listened. */
  probedSeconds: z.number().nonnegative(),
  /** Segment probed, echoed from the input. */
  subnet: z.string().max(64).optional(),
  /**
   * Set when discovery could not run at all (the discovery provider is not configured or is
   * unreachable). Distinct from "ran and found nothing" — an installer must be able to tell a broken
   * tool from an empty network, and a bare empty list cannot.
   */
  unavailable: z.string().max(500).optional(),
});
export type DiscoverCamerasResult = z.infer<typeof DiscoverCamerasResult>;

/**
 * Onboard several cameras in one call (P-1) — the DVR/NVR case, where one device publishes 8, 16 or
 * 32 channels and adding them one at a time is the difference between a five-minute install and an
 * afternoon.
 */
export const BulkCreateCamerasInput = z.object({
  /**
   * Deliberately `unknown[]` at the envelope, validated **per item** against `CreateCameraInput`.
   *
   * Typing this as `CreateCameraInput[]` would make one malformed channel reject all sixteen at parse
   * time — and would make `BulkCreateCameraResult.error` a promise the shape cannot keep, since a
   * schema failure would never reach it. An installer pasting a list of DVR channel URLs with one
   * typo must get fifteen cameras and one named error, not a 400 and no explanation of which row.
   *
   * The cost is that callers lose compile-time checking of the array's element type; the count and
   * bounds are still enforced here, and each element is still validated against the same contract.
   */
  cameras: z.array(z.unknown()).min(1).max(64),
});
export type BulkCreateCamerasInput = z.infer<typeof BulkCreateCamerasInput>;

/**
 * Per-camera outcome of a bulk onboard. **Partial success is the expected case**, not an error: one
 * duplicate channel in a 16-channel DVR must not discard the other fifteen, and an installer needs to
 * see exactly which one failed and why.
 */
export const BulkCreateCameraResult = z.object({
  /** Index in the submitted array, so the console can point at the row that failed. */
  index: z.number().int().nonnegative(),
  name: z.string().max(200),
  created: z.boolean(),
  camera: Camera.optional(),
  error: z.string().max(500).optional(),
});
export type BulkCreateCameraResult = z.infer<typeof BulkCreateCameraResult>;

/** Result of a bulk onboard (P-1). */
export const BulkCreateCamerasResult = z.object({
  results: z.array(BulkCreateCameraResult).default([]),
  created: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type BulkCreateCamerasResult = z.infer<typeof BulkCreateCamerasResult>;

/**
 * Candidate camera configuration to validate before onboarding (P2-2 G-1, "test connection").
 * Deliberately **lenient** (no schema-level refinements) so the validator can *report* problems as
 * structured checks instead of rejecting the request — the console uses it to pre-flight a config.
 */
export const CameraValidationInput = z.object({
  protocol: CameraProtocol,
  streamUrl: z.string().min(1).max(2048),
  credentials: StreamCredentials.optional(),
  capture: CaptureProfile.optional(),
});
export type CameraValidationInput = z.infer<typeof CameraValidationInput>;

/** One deterministic validation check (P2-2 G-1). */
export const CameraValidationCheck = z.object({
  /** Stable machine name, e.g. `stream-url-scheme`, `protocol-matches-url`, `reachability`. */
  name: z.string().min(1),
  passed: z.boolean(),
  /** Human explanation when a check fails, or an informational note. */
  message: z.string().max(500).optional(),
  /**
   * Informational checks (e.g. `reachability`, deferred to ingestion in G-2) do not affect `valid`.
   */
  informational: z.boolean().default(false),
});
export type CameraValidationCheck = z.infer<typeof CameraValidationCheck>;

/**
 * Result of validating a camera configuration or an existing camera (P2-2 G-1). `valid` is the AND
 * of all non-informational checks — active network reachability is intentionally NOT proven here
 * (that is the ingestion path's job, arriving with the Media enabler G-2).
 */
export const CameraValidationResult = z.object({
  valid: z.boolean(),
  checks: z.array(CameraValidationCheck),
});
export type CameraValidationResult = z.infer<typeof CameraValidationResult>;

// ---------------------------------------------------------------------------------------------
// Stream probe — the measurement behind every measured lifecycle state (P-2)
// ---------------------------------------------------------------------------------------------

/**
 * Ask the runtime to open a stream and report what it actually saw (Architect P-1 rec 4: "validate
 * RTSP connectivity, credentials, stream profile, supported codec, reachable FPS, expected
 * resolution").
 *
 * The runtime is the only component that can do this — it owns the decode path — but this is a
 * *measurement*, not perception: no session is created and no inference runs. The camera service
 * calls it through a port, exactly as it calls discovery (ADR-0023, ADR-0024).
 */
export const StreamProbeRequest = z.object({
  protocol: CameraProtocol.default('rtsp'),
  /** Lenient (not `StreamUrl`): the point of a probe is to *report* a bad URL, not 400 on it. */
  streamUrl: z.string().min(1).max(2048),
  credentials: StreamCredentials.optional(),
  /** Give up after this long. Short by default — an installer is standing in front of the camera. */
  timeoutSeconds: z.number().min(1).max(60).default(8),
  /** How many frames to read before declaring success. >1 catches a device that opens then stalls. */
  frames: z.number().int().min(1).max(30).default(3),
});
export type StreamProbeRequest = z.infer<typeof StreamProbeRequest>;

/**
 * The ordered checks a probe performs (Architect P-2 rec 3 + rec 7). **The order is the contract**:
 * each check depends on the one before it, so a failure at `authentication` leaves everything after
 * it `not-executed` rather than `fail`.
 *
 * That distinction is the entire installer experience. "Connection failed" sends someone to check
 * cabling; "✓ reachable, ✗ invalid credentials, — stream not attempted" sends them to the password,
 * and they are done in a minute instead of an afternoon.
 */
/**
 * Why a probe failed — **exactly one**, and mutually exclusive (P-2.1, Architect rec 8).
 *
 * The *server* names the failure and the console renders it. A UI that infers "probably credentials"
 * from an error string is business logic in the wrong tier, and it will disagree with the runtime the
 * first time a message is reworded. Overlapping codes would defeat the purpose too: an installer
 * needs one remedy, not a set of maybes.
 */
export const StreamProbeFailureCode = z.enum([
  'configuration-invalid',
  'dns-failure',
  'tcp-failure',
  'authentication-failure',
  'rtsp-negotiation-failure',
  'codec-unsupported',
  'timeout',
  'no-first-frame',
  'stream-interrupted',
]);
export type StreamProbeFailureCode = z.infer<typeof StreamProbeFailureCode>;

/**
 * A registered **validation provider** — one kind of source the staged pipeline can validate
 * (P-2.2, Architect rec 1).
 *
 * **The staged pipeline is the platform's one validation engine**, and this enum is how it stays
 * that way. A new source type is an entry here plus a `register_provider(...)` row in the runtime
 * declaring which stages it has — never a second validation path with its own idea of what
 * "connected" means. That is also why `skipped` exists on a check: an HTTP source has no RTSP
 * negotiation, and a provider-specific probe would express that by simply not having the stage,
 * which is indistinguishable from a stage that silently stopped running.
 *
 * Deliberately *providers* rather than transports: a recorded DVR export, an NVR playback file and a
 * USB camera are not transports at all, and they still have to be validated through the same
 * pipeline so their reports can be read beside an RTSP one. The local providers have no DNS, TCP or
 * authentication stage whatsoever.
 */
export const ValidationProvider = z.enum([
  'rtsp',
  'rtsps',
  'rtmp',
  'rtmps',
  'http',
  'https',
  'srt',
  'webrtc',
  'onvif-pullpoint',
  'recorded-video',
  'dvr-export',
  'nvr-playback',
  'usb-camera',
  'edge-stream',
  'simulated',
  'unknown',
]);
export type ValidationProvider = z.infer<typeof ValidationProvider>;

export const StreamProbeCheckName = z.enum([
  /** The hostname resolved. Splitting this out sends someone to their DNS, not to their cabling. */
  'dns',
  /** A TCP connection to the stream port succeeded. A firewall and a dead camera fail differently. */
  'tcp',
  /** The device accepted the credentials it was offered. */
  'authentication',
  /** RTSP DESCRIBE/SETUP/PLAY completed — the device agreed to serve this stream. */
  'rtsp-negotiation',
  /** The source opened. */
  'stream-open',
  /** A decodable frame arrived. Distinct from `stream-open`: devices routinely do one without the other. */
  'first-frame',
  'frames-received',
  'codec',
  'resolution',
  'fps',
  /** The device published a profile matching what was requested. */
  'stream-profile',
  'latency',
  'jitter',
]);
export type StreamProbeCheckName = z.infer<typeof StreamProbeCheckName>;

/**
 * One probe check. `not-executed` is a first-class status, not a failure: it means the probe never
 * got far enough to find out, and reporting it as a failure would blame the wrong component.
 */
export const StreamProbeCheck = z.object({
  name: StreamProbeCheckName,
  /**
   * `skipped` means this transport has no such stage (an HTTP source has no RTSP negotiation) —
   * deliberately distinct from `not-executed`, which means the probe never got that far.
   */
  status: z.enum(['pass', 'fail', 'warn', 'skipped', 'not-executed']),
  /**
   * Wall-clock cost of this stage (P-2.1, Architect rec 1). Total probe time cannot say *which* step
   * is slow, and "the camera is slow" and "negotiation takes 1.4s" are different problems with
   * different fixes. Absent when the stage did not run or has no meaningful duration.
   */
  durationMs: z.number().nonnegative().optional(),
  /** What was measured, as displayed — e.g. `1920x1080`, `18.6 fps`, `412 ms`. */
  measured: z.string().max(120).optional(),
  detail: z.string().max(300).optional(),
});
export type StreamProbeCheck = z.infer<typeof StreamProbeCheck>;

/**
 * What the probe measured — a **report**, not a boolean (Architect P-2 rec 3).
 *
 * **`evidenceClass` is the load-bearing field.** A probe against a simulated source returns
 * `simulated` and a probe against a recorded file returns `recorded-footage` — and the camera service
 * refuses to move a camera to `connected` on either, no matter how flawless the numbers are. Without
 * that rule a demo environment would quietly report a fully connected estate, which is precisely the
 * failure mode AI-5e was built to make impossible (CONSTRAINTS §18, §25). The same value is what
 * certification, capability maturity and benchmark reports read, so one measurement means one thing
 * everywhere in the platform (Architect P-2 rec 10).
 */
export const StreamProbeResult = z.object({
  probedAt: IsoDateTime,
  evidenceClass: EvidenceClass,
  /**
   * Version of the probe implementation that produced this report (P-2.1, Architect P-2 rec 6).
   *
   * Two probe reports six months apart are only comparable if you know whether the probe itself
   * changed in between. Without this, a fleet that "got slower" is indistinguishable from a probe
   * that started measuring latency from a different point, and there is no way to tell after the
   * fact — the reports look identical.
   */
  probeVersion: z.string().max(20).default('1'),
  /** Runtime build that ran the probe. */
  runtimeVersion: z.string().max(40).optional(),
  /**
   * Which validation provider ran the staged pipeline (P-2.2). Recorded so a report can be read
   * correctly years later: a `skipped` RTSP-negotiation row means "this source type has no such
   * stage", and without knowing the provider that is indistinguishable from a stage that was
   * quietly dropped.
   */
  provider: ValidationProvider.optional(),
  /** Hash/label of the camera configuration probed, when the caller supplies one. */
  configVersion: z.string().max(64).optional(),
  /** The ordered check list — this is what the console renders. */
  checks: z.array(StreamProbeCheck).default([]),
  /** The source opened. */
  reachable: z.boolean(),
  /** Frames actually decoded. Zero with `reachable: true` is the "opens then stalls" device. */
  framesRead: z.number().int().nonnegative(),
  /** Milliseconds to open the source. */
  connectMs: z.number().nonnegative().optional(),
  /** Milliseconds to the first decoded frame — what "slow camera" actually means. */
  firstFrameMs: z.number().nonnegative().optional(),
  /** Inter-frame interval variation, milliseconds. A steady 5 fps and a bursty one are not the same. */
  jitterMs: z.number().nonnegative().optional(),
  /** Measured, not declared: what the device really sent. */
  resolution: z
    .string()
    .regex(/^\d{2,5}x\d{2,5}$/, 'must be WIDTHxHEIGHT')
    .optional(),
  fps: z.number().nonnegative().optional(),
  codec: CameraCodec.optional(),
  authentication: CameraAuthState.default('unknown'),
  /** Profiles the device advertised at probe time, when it was asked. */
  profiles: z.array(CameraStreamProfile).max(10).default([]),
  /** Non-fatal observations — a working camera that will cost more than it should. */
  warnings: z.array(z.string().max(300)).max(10).default([]),
  /** Total wall-clock cost of the probe. The per-stage breakdown lives on `checks`. */
  totalMs: z.number().nonnegative().optional(),
  /** The single reason this probe failed. Absent on success. */
  failureCode: StreamProbeFailureCode.optional(),
  /** Who asked for this probe, when a person did. */
  operator: z.string().max(120).optional(),
  /** Ties this measurement to the request that caused it. */
  correlationId: z.string().max(120).optional(),
  /** Failure explanation, credentials redacted. */
  error: z.string().max(500).optional(),
});
export type StreamProbeResult = z.infer<typeof StreamProbeResult>;

/**
 * The camera-service response to "test this camera's connection" (P-2). Carries the measurement, the
 * health snapshot it produced, and the lifecycle state that resulted — including the case where the
 * state deliberately did **not** change because the evidence was not strong enough to justify it.
 */
export const CameraProbeReport = z.object({
  cameraId: z.string().min(1),
  probe: StreamProbeResult.optional(),
  operational: CameraOperationalHealth.optional(),
  lifecycle: CameraLifecycle,
  /**
   * Set when no probe could be run at all (no probe provider configured). Distinct from a probe that
   * ran and failed — the first is a deployment gap, the second is a camera problem, and sending an
   * installer to the wrong one costs an afternoon.
   */
  unavailable: z.string().max(500).optional(),
});
export type CameraProbeReport = z.infer<typeof CameraProbeReport>;

// ---------------------------------------------------------------------------------------------
// Capability cache + health history (P-2, Architect P-1 rec 3 / P-2 rec 2 + rec 6)
// ---------------------------------------------------------------------------------------------

/**
 * One field that changed between two capability reads (P-2.1, Architect P-2 rec 2).
 *
 * Values are rendered as strings rather than typed unions because this is a **diagnostic record**,
 * not a source of truth — the authoritative capabilities are the object itself. A camera that
 * silently started serving 4K H.265 where it used to serve 1080p H.264 has just quadrupled the
 * platform's decode cost, and this is the row that says so.
 */
/**
 * Impact of a capability change (P-2.1, Architect rec 2).
 *
 * - `minor` — descriptive: firmware string, friendly name. Nothing downstream behaves differently.
 * - `major` — changes what analysis costs or receives: resolution, codec, FPS, stream profile.
 *   A camera that silently moved from 1080p H.264 to 4K H.265 just quadrupled its decode cost.
 * - `security` — authentication mode, TLS, credential requirements. Read these first.
 */
export const CapabilityChangeSeverity = z.enum(['minor', 'major', 'security']);
export type CapabilityChangeSeverity = z.infer<typeof CapabilityChangeSeverity>;

/**
 * Which way a capability moved (P-2.2, Architect rec 3).
 *
 * `reduced` is the value this enum exists for. "Resolution changed" is a fact; "resolution reduced"
 * is a **regression** — the device is now sending less than the platform was configured to analyse,
 * and nobody upgrades a camera intending that. Direction is what lets a diff be ranked instead of
 * merely listed.
 */
export const CapabilityChangeDirection = z.enum([
  'added',
  'removed',
  'increased',
  'reduced',
  'changed',
]);
export type CapabilityChangeDirection = z.infer<typeof CapabilityChangeDirection>;

/**
 * What accounts for a capability change (P-2.2, Architect rec 3).
 *
 * The platform can only name a cause it actually observed: a firmware string that moved in the same
 * read, or an operator write it performed itself. Everything else is `unexplained` — and
 * `unexplained` is not a shrug, it is the finding. A camera whose codec changed with no firmware
 * upgrade and no operator action was reconfigured by somebody outside this platform.
 */
export const CapabilityDriftCause = z.enum([
  'firmware-upgrade',
  'operator-update',
  'first-observation',
  'unexplained',
]);
export type CapabilityDriftCause = z.infer<typeof CapabilityDriftCause>;

/**
 * Whether a change was accounted for (P-2.2, Architect rec 3).
 *
 * `unexpected` is the highlight condition, and it is **not** simply "cause is unexplained": a
 * *reduction* stays unexpected even under a firmware upgrade. Losing a stream profile or dropping
 * from 1080p to VGA is a regression whoever ran the upgrade did not intend, and attributing it to
 * the upgrade would file the one thing worth investigating under "explained".
 */
export const CapabilityDrift = z.enum(['expected', 'unexpected']);
export type CapabilityDrift = z.infer<typeof CapabilityDrift>;

export const CapabilityChange = z.object({
  /** Dotted path within `CameraCapabilities`, e.g. `codecs`, `streamProfiles.sub.resolution`. */
  field: z.string().min(1).max(120),
  severity: CapabilityChangeSeverity,
  /** Absent when the field was previously unset. */
  from: z.string().max(200).optional(),
  /** Absent when the field was removed. */
  to: z.string().max(200).optional(),
  /** Which way it moved (P-2.2). `changed` when the values are not comparable as magnitudes. */
  direction: CapabilityChangeDirection.default('changed'),
  /** What the platform can actually attribute the change to (P-2.2). */
  cause: CapabilityDriftCause.default('unexplained'),
  /** Whether it was accounted for. `unexpected` is what the console highlights (P-2.2). */
  drift: CapabilityDrift.default('unexpected'),
});
export type CapabilityChange = z.infer<typeof CapabilityChange>;

/**
 * One capability refresh's changes, as a single logical event (P-2.3, Architect rec 5).
 *
 * A firmware update that moves the codec, the resolution, a profile and the frame rate produces four
 * rows at the same instant. Presented as four unrelated lines they read as four problems; presented
 * as one event with a named cause they read as what they are — *one upgrade, four consequences*. The
 * grouping is what makes the difference visible, and it costs nothing because the refresh already
 * knew all four belonged together.
 */
export const CapabilityChangeSet = z.object({
  changeSetId: z.string().min(1).max(120),
  at: IsoDateTime,
  /** What accounted for the whole set — the same attribution every member carries. */
  cause: CapabilityDriftCause,
  /** `unexpected` when any member is: one unexplained codec change taints the set. */
  drift: CapabilityDrift,
  /** Firmware before and after, when the refresh observed a change. */
  firmwareFrom: z.string().max(100).optional(),
  firmwareTo: z.string().max(100).optional(),
  changes: z.array(CapabilityChange).max(50).default([]),
});
export type CapabilityChangeSet = z.infer<typeof CapabilityChangeSet>;

/**
 * Result of a capability read (P-2). Capabilities are **cached, not re-queried** — an ONVIF
 * negotiation is several round trips and a device that is asked for its profiles on every session
 * start is a device that will eventually refuse. They refresh only when asked, when stale, or when
 * the firmware changes underneath them.
 */
export const CapabilityRefreshResult = z.object({
  cameraId: z.string().min(1),
  capabilities: CameraCapabilities,
  cache: CapabilityCache,
  reason: CapabilityRefreshReason,
  /** True when the device was actually contacted. False = this came from the cache. */
  refreshed: z.boolean(),
  /**
   * What changed. Empty on a cache hit, and empty on a refresh that found the device unchanged —
   * which is itself the useful answer most of the time.
   */
  changes: z.array(CapabilityChange).max(50).default([]),
  /** The same changes as one logical event, with the cause that accounts for them (P-2.3 rec 5). */
  changeSet: CapabilityChangeSet.optional(),
  /** Set when a refresh was warranted but could not be performed. */
  unavailable: z.string().max(500).optional(),
});
export type CapabilityRefreshResult = z.infer<typeof CapabilityRefreshResult>;

/**
 * Trends, not status (Architect P-2 rec 6). Operators investigating a complaint ask "has this camera
 * been reliable this month?", and the current state cannot answer that — a camera that is online
 * right now and dropped forty times yesterday looks identical to one that has never faltered.
 *
 * **`observations` is the honesty field.** An availability percentage computed from two data points
 * is not a trend, and a UI that renders it as one is inviting a decision the data does not support.
 * Every summary carries how much evidence is behind it, and `availabilityPercent` stays absent when
 * there is not enough to say.
 */
/**
 * Trend windows (P-2.1, Architect rec 5). A lifetime average hides last night's outage behind a
 * year of uptime, which is exactly the failure an operator is investigating when they look.
 */
export const HealthTrendWindow = z.enum(['hour', 'day', 'week', 'month']);
export type HealthTrendWindow = z.infer<typeof HealthTrendWindow>;

/**
 * How much the platform trusts this camera to keep working (P-2.2, Architect rec 4).
 *
 * **This is not AI confidence and must never be read as one.** AI confidence is a model's certainty
 * about what it saw in a frame. This is an operational reliability score computed from measured
 * device history — availability, how often it dropped, how often it was reachable but not serving,
 * how often credentials were rejected. The two answer different questions for different people, and
 * a dashboard that puts them in the same column will eventually have someone dismiss a detection
 * because "the camera was only 72% confident".
 *
 * `insufficient-evidence` is a first-class band with **no score at all**. A percentage computed from
 * two observations is arithmetic wearing a uniform, and the whole point of this platform's evidence
 * discipline is not to issue those.
 */
export const OperationalConfidenceBand = z.enum([
  /** Consistently reachable and serving. */
  'stable',
  /** Works, but has dropped or flapped within the window. */
  'intermittent',
  /** Failing often enough that an operator should not rely on it. */
  'failing',
  /** Not enough measured history in this window to say anything. */
  'insufficient-evidence',
]);
export type OperationalConfidenceBand = z.infer<typeof OperationalConfidenceBand>;

export const OperationalConfidence = z.object({
  band: OperationalConfidenceBand,
  /** 0–100. **Absent** on `insufficient-evidence` — the band is the whole answer there. */
  score: z.number().min(0).max(100).optional(),
  /** How many measured observations the score rests on. Always present, including when the score is not. */
  observations: z.number().int().nonnegative(),
  /**
   * The reasons, in the operator's words — "dropped 3 times", "credentials rejected twice". A bare
   * number invites an argument; the reasons behind it end one.
   */
  basis: z.array(z.string().max(160)).max(6).default([]),
});
export type OperationalConfidence = z.infer<typeof OperationalConfidence>;

/** One point in a confidence trend — a confidence computed over one bucket of the window. */
export const ConfidencePoint = z.object({
  /** End of the bucket this point covers. */
  at: IsoDateTime,
  band: OperationalConfidenceBand,
  /** Absent on `insufficient-evidence` — a gap in the line, not a zero (P-2.3 rec 4). */
  score: z.number().min(0).max(100).optional(),
  observations: z.number().int().nonnegative(),
});
export type ConfidencePoint = z.infer<typeof ConfidencePoint>;

/**
 * How a camera's reliability has moved (P-2.3, Architect rec 4).
 *
 * **The latest confidence answers the wrong question.** A camera reading 92% right now looks
 * identical whether it has always been 92% or was 40% for three weeks and has just recovered — and
 * the second is the one an operator planning a site visit needs to know about. A trend makes the
 * difference visible; a single number cannot.
 *
 * Computed from the immutable archive on every read, like every other metric here, so the trend and
 * the reports behind it can never disagree. **A bucket with too little evidence has no score at
 * all** and is left as a gap: interpolating one would draw a confident line through a period nobody
 * measured.
 */
export const ConfidenceTrend = z.object({
  cameraId: z.string().min(1),
  window: HealthTrendWindow,
  windowStart: IsoDateTime,
  windowEnd: IsoDateTime,
  /** Oldest first, so it reads left to right. */
  points: z.array(ConfidencePoint).max(60).default([]),
  /** Confidence over the whole window — what a single-number display should show. */
  current: OperationalConfidence,
});
export type ConfidenceTrend = z.infer<typeof ConfidenceTrend>;

// ---------------------------------------------------------------------------------------------
// Operational decision records (P-2.3, Architect rec 8) — explainability, not behaviour
// ---------------------------------------------------------------------------------------------

/** The automated decisions the platform makes about a camera. */
export const OperationalDecisionKind = z.enum([
  /** A lifecycle transition the platform applied — or deliberately did not apply. */
  'lifecycle-state',
  /** How a probe's outcome was classified. */
  'probe-outcome',
  /** Whether a capability refresh went back to the device. */
  'capability-refresh',
  /** How a capability change was attributed and whether it needs attention. */
  'capability-drift',
  /** What a firmware, codec or provider has been proven to do. */
  'compatibility-status',
  /** The operational confidence band, and what moved it. */
  'confidence',
]);
export type OperationalDecisionKind = z.infer<typeof OperationalDecisionKind>;

/** Who or what decided. */
export const DecisionActor = z.enum(['runtime', 'camera-service', 'operator']);
export type DecisionActor = z.infer<typeof DecisionActor>;

/**
 * Why the platform did what it did (P-2.3, Architect rec 8).
 *
 * **Explainability only — this introduces no runtime behaviour.** Nothing consults a decision record
 * to decide anything; they are reconstructed from stored evidence so an operator can ask *why was
 * this camera degraded?*, *why was this probe marked failed?*, *why did confidence drop?* and get the
 * actual rule and the actual evidence rather than a guess.
 *
 * **Derived, never persisted** (rec 4). Every input is already in the archive, and a stored decision
 * would be a second copy of a conclusion that could drift from the evidence it was drawn from — the
 * precise failure the evidence layer exists to prevent. It also means an explanation improves
 * retroactively when the explanation improves, instead of leaving old records phrased in the words
 * of whatever version wrote them.
 */
export const OperationalDecision = z.object({
  kind: OperationalDecisionKind,
  at: IsoDateTime,
  actor: DecisionActor,
  /** What was decided, in the platform's own vocabulary — `degraded`, `failed`, `unsupported`. */
  decision: z.string().min(1).max(120),
  /** The rule that produced it, in the words an operator needs. */
  reason: z.string().min(1).max(500),
  /** The machine-readable reason, where the decision has one. */
  reasonCode: TimelineReasonCode.optional(),
  /**
   * Evidence ids backing the decision — resolvable in the evidence timeline.
   *
   * A decision with no supporting evidence is an opinion, and the platform does not issue those.
   */
  supportingEvidence: z.array(z.string().max(200)).max(10).default([]),
  /** The class of evidence the decision rests on. Absent when it rests on configuration alone. */
  evidenceClass: EvidenceClass.optional(),
});
export type OperationalDecision = z.infer<typeof OperationalDecision>;

/** Every explainable decision about one camera, most recent first. */
export const CameraDecisionLog = z.object({
  cameraId: z.string().min(1),
  from: IsoDateTime,
  to: IsoDateTime,
  decisions: z.array(OperationalDecision).max(200).default([]),
});
export type CameraDecisionLog = z.infer<typeof CameraDecisionLog>;

export const CameraHealthSummary = z.object({
  cameraId: z.string().min(1),
  window: HealthTrendWindow,
  windowStart: IsoDateTime,
  windowEnd: IsoDateTime,
  /** How many timeline entries this summary was computed from. */
  observations: z.number().int().nonnegative(),
  /** Share of the window spent in a healthy state. Absent when too little was observed to say. */
  availabilityPercent: z.number().min(0).max(100).optional(),
  /** Transitions back into a healthy state — the flapping signal. */
  reconnects: z.number().int().nonnegative(),
  /** How many times it dropped. Distinct from `offlineSeconds`: eight blips ≠ one eight-hour outage. */
  offlineCount: z.number().int().nonnegative(),
  credentialFailures: z.number().int().nonnegative(),
  offlineSeconds: z.number().int().nonnegative(),
  averageLatencyMs: z.number().nonnegative().optional(),
  /** Mean wall-clock cost of a probe — a camera that takes 9s to answer is a camera in trouble. */
  averageProbeMs: z.number().nonnegative().optional(),
  capabilityRefreshes: z.number().int().nonnegative(),
  firmwareChanges: z.number().int().nonnegative(),
  /** Operational reliability over this window (P-2.2) — never an AI confidence. */
  confidence: OperationalConfidence.optional(),
});
export type CameraHealthSummary = z.infer<typeof CameraHealthSummary>;

// ---------------------------------------------------------------------------------------------
// Immutable probe evidence: history, correlation, replay, metrics (P-2.2)
// ---------------------------------------------------------------------------------------------

/**
 * The configuration a probe actually ran against (P-2.2, Architect rec 1).
 *
 * Without this a stored report is unreadable a month later. "First frame took 4.1s" means one thing
 * against a 4K main stream and something else entirely against a 640×360 sub-stream, and a camera
 * that was reconfigured in between makes the two reports look like a regression when they measured
 * different things. Snapshotted at probe time, never back-filled from the camera's current state —
 * back-filling would silently rewrite history to match the present, which is the failure this whole
 * subsystem exists to prevent.
 *
 * Carries `credentialsSupplied` as a boolean and never the credentials themselves.
 */
export const ProbeConfigurationSnapshot = z.object({
  protocol: CameraProtocol,
  /** Never credentialed — the same rule as `StreamUrl`, enforced by what writes this. */
  streamUrl: z.string().max(2048),
  provider: ValidationProvider.default('unknown'),
  credentialsSupplied: z.boolean().default(false),
  captureCodec: CameraCodec.optional(),
  captureResolution: z
    .string()
    .regex(/^\d{2,5}x\d{2,5}$/, 'must be WIDTHxHEIGHT')
    .optional(),
  captureFps: z.number().int().min(1).max(120).optional(),
  /** The named device profile requested, when one was. */
  streamProfile: z.string().max(100).optional(),
  /** Version of the capability payload the probe was run against. */
  capabilityCacheVersion: z.number().int().min(1).optional(),
  /** Firmware on file at probe time — what makes `FirmwareCompatibility` attributable. */
  firmware: z.string().max(100).optional(),
});
export type ProbeConfigurationSnapshot = z.infer<typeof ProbeConfigurationSnapshot>;

/** What a probe execution concluded. `unavailable` = no probe could be run at all. */
export const ProbeOutcome = z.enum(['succeeded', 'failed', 'unavailable']);
export type ProbeOutcome = z.infer<typeof ProbeOutcome>;

/**
 * One probe execution, as **immutable evidence** (P-2.2, Architect rec 1).
 *
 * Before this, each probe overwrote `Camera.operational` and the previous measurement ceased to
 * exist. That makes the single most common operational question unanswerable: *was it always like
 * this?* A camera taking 4 seconds to first frame is unremarkable if it always did and is an
 * incident if it took 300ms last week — and the difference is only visible if last week's report
 * still exists.
 *
 * Records are **appended and never mutated**. Retention is bounded per camera and reported
 * explicitly (`CameraProbeHistory.evicted`), so the platform never implies it holds a complete
 * archive it has trimmed.
 *
 * The full `result` is stored, which is what makes replay (rec 5) a pure function over stored
 * evidence rather than a re-measurement wearing the old one's timestamp.
 */
export const CameraProbeRecord = z.object({
  probeId: z.string().min(1).max(120),
  cameraId: z.string().min(1),
  at: IsoDateTime,
  /**
   * This camera's probe ordinal — 1 for its first ever probe.
   *
   * A timestamp is not a total order. Two probes can land in the same millisecond (a retry, a
   * scheduled sweep, a test suite with a fixed clock), and sorting on time alone leaves their order
   * — and therefore the `previousProbeId` chain that "when did this start failing?" walks — down to
   * whatever the storage engine happened to return.
   */
  sequence: z.number().int().positive(),
  outcome: ProbeOutcome,
  /** The class of evidence — a report is only ever as strong as this (AI-5e, CONSTRAINTS §18). */
  evidenceClass: EvidenceClass,
  probeVersion: z.string().max(20).default('1'),
  runtimeVersion: z.string().max(40).optional(),
  /** Which registered validation provider produced this evidence. */
  provider: ValidationProvider.default('unknown'),
  /**
   * Ties this measurement to the request that caused it, across services. Lifted onto the record
   * rather than left inside `result` so it survives an `unavailable` outcome — the case where there
   * is no result and correlating the gap with a deployment change is the entire investigation.
   */
  correlationId: z.string().max(120).optional(),
  failureCode: StreamProbeFailureCode.optional(),
  /** Device identity as it stood at probe time — which camera this measurement is *about*. */
  identity: CameraDeviceIdentity.optional(),
  configuration: ProbeConfigurationSnapshot,
  /** The full staged report. Absent only on `unavailable`, where there was nothing to record. */
  result: StreamProbeResult.optional(),
  /** Lifecycle state before this probe, and after it moved (or did not). */
  lifecycleBefore: CameraLifecycleState,
  lifecycleAfter: CameraLifecycleState,
  // --- correlation (Architect rec 2) -----------------------------------------------------------
  /**
   * The probe immediately before this one. A single pointer rather than an index because the chain
   * is what an operator walks: "when did this start failing?" is answered by following it back to
   * the last `succeeded`, and a list would have to be re-sorted to answer the same question.
   */
  previousProbeId: z.string().max(120).optional(),
  previousProbeAt: IsoDateTime.optional(),
  previousOutcome: ProbeOutcome.optional(),
  previousFailureCode: StreamProbeFailureCode.optional(),
  /** When capabilities were last read from the device, as of this probe. */
  capabilitySnapshotAt: IsoDateTime.optional(),
  /** When the camera's identity last changed, as of this probe. */
  identitySnapshotAt: IsoDateTime.optional(),
  /**
   * The record this one corrects (P-2.3, Architect rec 1).
   *
   * **A correction is never an update.** When a report turns out to be wrong — a probe misattributed
   * to the wrong device, a measurement invalidated by a runtime defect — the fix is a new record
   * pointing back at the old one, and the old one stays exactly as it was written. Overwriting it
   * would destroy the only evidence that the platform once believed something different, which is
   * frequently the thing an investigation is actually about.
   *
   * Deliberately a **backward** pointer only: recording the correction on the superseded record
   * would be a modification of stored evidence, which is the rule this field exists to keep.
   */
  supersedes: z.string().max(120).optional(),
  /** Why the earlier record was superseded, in the operator's words. */
  supersedesReason: z.string().max(300).optional(),
});
export type CameraProbeRecord = z.infer<typeof CameraProbeRecord>;

/**
 * A camera's retained probe history, most recent first.
 *
 * **`evicted` is the honesty field.** Retention is bounded — a camera probed every five minutes
 * produces a hundred thousand reports a year — and a list that simply stops without saying so would
 * let a console render "3 probes, all successful" for a camera with a hundred failures behind them.
 */
export const CameraProbeHistory = z.object({
  cameraId: z.string().min(1),
  records: z.array(CameraProbeRecord).max(200).default([]),
  /** Probes ever run against this camera. */
  total: z.number().int().nonnegative(),
  /** Reports retained right now. */
  retained: z.number().int().nonnegative(),
  /** Reports that existed and have been aged out. Non-zero means this view is partial. */
  evicted: z.number().int().nonnegative(),
});
export type CameraProbeHistory = z.infer<typeof CameraProbeHistory>;

/** How one stage's status moved between two probes. */
export const ProbeStageChange = z.object({
  name: StreamProbeCheckName,
  from: z.enum(['pass', 'fail', 'warn', 'skipped', 'not-executed']),
  to: z.enum(['pass', 'fail', 'warn', 'skipped', 'not-executed']),
});
export type ProbeStageChange = z.infer<typeof ProbeStageChange>;

/**
 * Two probes, compared (P-2.2, Architect rec 2).
 *
 * The comparison is the diagnosis. One failing probe says a camera is broken; the same probe against
 * its predecessor says *authentication used to pass and now does not*, which names the change and
 * usually the person who made it.
 */
export const ProbeComparison = z.object({
  previousProbeId: z.string().max(120),
  previousAt: IsoDateTime,
  outcomeChanged: z.boolean(),
  previousOutcome: ProbeOutcome,
  previousFailureCode: StreamProbeFailureCode.optional(),
  /** Positive = slower than last time. */
  totalMsDelta: z.number().optional(),
  firstFrameMsDelta: z.number().optional(),
  /** Stages whose status differs. Empty means the two probes behaved identically stage for stage. */
  stageChanges: z.array(ProbeStageChange).max(13).default([]),
  /** True when the configuration also changed between the two — the confound worth naming first. */
  configurationChanged: z.boolean().default(false),
});
export type ProbeComparison = z.infer<typeof ProbeComparison>;

/**
 * A stored probe, reconstructed **without contacting the camera** (P-2.2, Architect rec 5).
 *
 * Support work happens hours or days after the failure, usually from a different building, and
 * frequently for a camera that has since been power-cycled into working again. Re-running the probe
 * at that point measures a different moment and answers a different question. Replay reconstructs
 * the stage order, the timings, the outputs, the failure point and the evidence class exactly as
 * they were recorded — it is a pure function over stored evidence, and it cannot accidentally become
 * a live measurement because it has no access to a camera at all.
 */
export const ProbeReplay = z.object({
  probeId: z.string().min(1).max(120),
  cameraId: z.string().min(1),
  /** When the probe ran. */
  recordedAt: IsoDateTime,
  /** When this reconstruction was produced — never mistakable for the measurement's own timestamp. */
  replayedAt: IsoDateTime,
  evidenceClass: EvidenceClass,
  probeVersion: z.string().max(20),
  runtimeVersion: z.string().max(40).optional(),
  provider: ValidationProvider.default('unknown'),
  outcome: ProbeOutcome,
  failureCode: StreamProbeFailureCode.optional(),
  /** The stage the probe stopped at, when it failed. Absent on success. */
  failedStage: StreamProbeCheckName.optional(),
  configuration: ProbeConfigurationSnapshot,
  identity: CameraDeviceIdentity.optional(),
  /** The staged report exactly as recorded, in the order it was recorded. */
  stages: z.array(StreamProbeCheck).default([]),
  totalMs: z.number().nonnegative().optional(),
  warnings: z.array(z.string().max(300)).max(10).default([]),
  /** Comparison against the preceding probe, when there was one. */
  comparison: ProbeComparison.optional(),
});
export type ProbeReplay = z.infer<typeof ProbeReplay>;

/** Mean cost of one pipeline stage across a window. */
export const ProbeStageMetric = z.object({
  stage: StreamProbeCheckName,
  averageMs: z.number().nonnegative(),
  /** How many probes contributed. A one-sample average is reported as such, never as a trend. */
  samples: z.number().int().positive(),
});
export type ProbeStageMetric = z.infer<typeof ProbeStageMetric>;

/**
 * Long-term probe performance for one camera (P-2.2, Architect rec 8).
 *
 * Computed from the retained reports on every read, never accumulated into stored counters. A stored
 * average cannot be recomputed when the window changes and cannot be audited against the evidence it
 * came from; deriving it means the number and the reports behind it can never disagree.
 *
 * These are per-camera and roll up to a fleet dashboard later — the aggregate is a different query
 * over the same records, not a different metric.
 */
export const CameraProbeMetrics = z.object({
  cameraId: z.string().min(1),
  window: HealthTrendWindow,
  windowStart: IsoDateTime,
  windowEnd: IsoDateTime,
  probes: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  /** Absent when no probe ran in the window — 0% and "never probed" are not the same claim. */
  successRatePercent: z.number().min(0).max(100).optional(),
  averageTotalMs: z.number().nonnegative().optional(),
  averageFirstFrameMs: z.number().nonnegative().optional(),
  /** Per-stage averages: which step of the pipeline the time is actually going into. */
  stages: z.array(ProbeStageMetric).max(13).default([]),
  /** Mean cost of a capability refresh, from the timeline. Absent when none was recorded. */
  averageCapabilityRefreshMs: z.number().nonnegative().optional(),
  /** How many of the contributing probes measured real hardware. Everything else proves the platform. */
  hardwareProbes: z.number().int().nonnegative(),
});
export type CameraProbeMetrics = z.infer<typeof CameraProbeMetrics>;

// ---------------------------------------------------------------------------------------------
// The unified evidence timeline + fleet metrics (P-2.2, Architect rec 7 + rec 8)
// ---------------------------------------------------------------------------------------------

/**
 * Which record a piece of evidence came from.
 *
 * The platform keeps four write models — the lifecycle timeline, the identity history, the
 * capability cache and the immutable probe archive — because they have genuinely different shapes,
 * bounds and write paths. This enum is what lets them be *read* as one thing.
 */
export const CameraEvidenceSource = z.enum([
  'lifecycle',
  'identity',
  'capability',
  'probe',
  'compatibility',
  'configuration',
  // Declared ahead of their producers (P-2.3, Architect rec 6). A consumer that already handles
  // these cannot be broken by the slice that starts emitting them, and adding an enum value later
  // is the one change to a published contract that is not purely additive for a strict parser.
  'diagnostics',
  'recovery',
  'certification',
  'session',
]);
export type CameraEvidenceSource = z.infer<typeof CameraEvidenceSource>;

/** How loudly an entry should read. `warning` is for the things an operator must not scroll past. */
export const CameraEvidenceSeverity = z.enum(['info', 'notice', 'warning']);
export type CameraEvidenceSeverity = z.infer<typeof CameraEvidenceSeverity>;

/**
 * What *kind* of thing an evidence item is (P-2.3, Architect rec 2).
 *
 * Finer-grained than `CameraEvidenceSource`, which says which record it came from. The type is what
 * a consumer keys behaviour off — "show me every probe report", "show me every identity change" —
 * and it is what lets a **new evidence type appear in the timeline without a UI redesign** (rec 7):
 * a renderer that switches on type must fall back, and one that reads the common envelope need not
 * switch at all.
 */
export const EvidenceType = z.enum([
  'probe-report',
  'state-change',
  'identity-change',
  'capability-refresh',
  'firmware-change',
  'compatibility-observation',
  'configuration-change',
  'credential-rotation',
]);
export type EvidenceType = z.infer<typeof EvidenceType>;

/** Which component produced a piece of evidence. */
export const EvidenceProducer = z.enum(['camera-service', 'ai-runtime', 'discovery', 'operator']);
export type EvidenceProducer = z.infer<typeof EvidenceProducer>;

/**
 * Where an investigator can go from one piece of evidence (P-2.3, Architect rec 3).
 *
 * **`rootCauseEvidenceId` is the field that shortens an investigation.** A camera that went offline,
 * failed three probes and lost a stream profile produces five rows that look like five problems;
 * they share one root, and following the pointer to it is the difference between reading a timeline
 * and understanding it.
 *
 * `previousEvidenceId` / `nextEvidenceId` link **related** evidence — the previous item of the same
 * type — not merely the adjacent row. "The probe before this one" is a question; "the row above" is
 * a scroll position.
 */
export const EvidenceLinks = z.object({
  cameraId: z.string().min(1),
  /** The previous item of the same evidence type, when there is one. */
  previousEvidenceId: z.string().max(200).optional(),
  nextEvidenceId: z.string().max(200).optional(),
  /** The earliest item in this entry's causal group — what actually started it. */
  rootCauseEvidenceId: z.string().max(200).optional(),
  /**
   * What this entry went on to cause (P-2.3, Architect rec 2).
   *
   * Root-cause navigation has to work in both directions. Walking backwards answers "why did this
   * happen?"; walking forwards answers "what did it break?" — which is the question asked when
   * deciding whether an incident is over, and it is unanswerable from a backward chain alone.
   */
  causedEvidenceIds: z.array(z.string().max(200)).max(20).default([]),
  /** The immutable probe report behind this entry. */
  probeId: z.string().max(120).optional(),
  /** When the capabilities in force at this moment were last read from the device. */
  capabilitySnapshotAt: IsoDateTime.optional(),
  /** Groups the rows of one logical change together (P-2.3 rec 5). */
  changeSetId: z.string().max(120).optional(),
});
export type EvidenceLinks = z.infer<typeof EvidenceLinks>;

/**
 * One event in a camera's life, whatever produced it (P-2.2 rec 8, provenance added P-2.3 rec 2).
 *
 * Every entry answers the same three questions in the same fields: **what changed** (`summary`,
 * `field`, `from`/`to`), **when** (`at`), and **why** (`reasonCode`, plus the addressable evidence
 * in `links`). That uniformity is the point — an investigator should not have to know which of four
 * subsystems recorded a fact in order to read it, and **a fifth subsystem should not require a new
 * renderer** (rec 7).
 *
 * The provenance block — `evidenceId` · `evidenceType` · `evidenceClass` · `producer` ·
 * `producerVersion` · `runtimeVersion` · `at` · `correlationId` — is identical on every evidence
 * type by construction, so a consumer can display, filter and correlate any of them without knowing
 * what it is looking at.
 */
export const CameraEvidenceEntry = z.object({
  /**
   * Stable identifier for this evidence item.
   *
   * **Derived deterministically from the record it came from**, never generated at read time: these
   * items are merged from four stores on every request, and a random id would make every link in
   * `EvidenceLinks` dangle the moment the page was refreshed.
   */
  evidenceId: z.string().min(1).max(200),
  evidenceType: EvidenceType,
  at: IsoDateTime,
  source: CameraEvidenceSource,
  /**
   * Tenant that owns this evidence. Redundant with the request's own scoping and carried anyway:
   * evidence gets exported, attached to tickets and quoted in reports, and a record that cannot say
   * whose estate it describes is a record that will eventually be attributed to the wrong customer.
   */
  tenantId: TenantId,
  /** The analysis session this evidence came from, when one produced it. */
  sessionId: z.string().max(120).optional(),
  producer: EvidenceProducer,
  /** Version of whatever produced it — a probe version, a cache version. */
  producerVersion: z.string().max(40).optional(),
  runtimeVersion: z.string().max(40).optional(),
  /** What changed, in one already-resolved line. */
  summary: z.string().max(300),
  /** Why — machine-readable, so the timeline can be filtered and counted rather than only read. */
  reasonCode: TimelineReasonCode,
  /** The strength of the claim behind this entry. */
  evidence: LifecycleEvidence,
  /** Present when a device was measured — absent on declared and administrative entries. */
  evidenceClass: EvidenceClass.optional(),
  severity: CameraEvidenceSeverity.default('info'),
  /** The attribute, capability path or compatibility value this entry is about. */
  field: z.string().max(120).optional(),
  from: z.string().max(200).optional(),
  to: z.string().max(200).optional(),
  correlationId: z.string().max(120).optional(),
  durationMs: z.number().nonnegative().optional(),
  /** Where an investigator can go from here (P-2.3 rec 3). */
  links: EvidenceLinks,
});
export type CameraEvidenceEntry = z.infer<typeof CameraEvidenceEntry>;

/**
 * A camera's whole recorded life, in order (P-2.2, Architect rec 8).
 *
 * **This is a derived read model, not a fifth store.** The Architect's closing recommendation was to
 * stop keeping four separate timelines; the decision taken here is to unify the *reading* and keep
 * the *writing* separate, because the four records are not interchangeable: the probe archive is
 * immutable and unbounded-in-principle, the lifecycle timeline is bounded at 50 so a flapping camera
 * cannot grow its own document without limit, the identity history is bounded at 30 and keyed by
 * attribute, and the compatibility register is keyed by (dimension, value) rather than by time.
 * Collapsing them into one physical log would force a single retention rule onto all four — either
 * throwing away probe evidence to keep the timeline small, or letting a camera that reconnects every
 * thirty seconds bury a firmware change under ten thousand identical rows.
 *
 * Merging on read costs one sort and gives the operator the single chronology they actually want,
 * with no second copy of any fact that could drift from the first.
 */
export const CameraEvidenceTimeline = z.object({
  cameraId: z.string().min(1),
  from: IsoDateTime,
  to: IsoDateTime,
  entries: z.array(CameraEvidenceEntry).max(300).default([]),
  /** Which records contributed. A source missing here contributed nothing in this window. */
  sources: z.array(CameraEvidenceSource).max(10).default([]),
  /**
   * True when entries were dropped to fit the bound. The console must say so rather than let a
   * partial chronology read as a complete one.
   */
  truncated: z.boolean().default(false),
});
export type CameraEvidenceTimeline = z.infer<typeof CameraEvidenceTimeline>;

/** One value and how often it occurs across a fleet — firmware versions, providers, statuses. */
export const DistributionEntry = z.object({
  value: z.string().min(1).max(120),
  count: z.number().int().nonnegative(),
});
export type DistributionEntry = z.infer<typeof DistributionEntry>;

/** How often one failure code occurred. */
export const FailureDistributionEntry = z.object({
  failureCode: StreamProbeFailureCode,
  count: z.number().int().nonnegative(),
});
export type FailureDistributionEntry = z.infer<typeof FailureDistributionEntry>;

/**
 * Probe performance across a whole tenant (P-2.2, Architect rec 7).
 *
 * The same computation as `CameraProbeMetrics` over every camera in scope, so the fleet view and the
 * camera view can never disagree — one is the other's aggregate, not a parallel implementation.
 *
 * **`camerasNeverProbed` is the field that keeps this honest.** A fleet dashboard reporting "98%
 * probe success" across the four cameras anyone has ever tested, out of an estate of three hundred,
 * is worse than no dashboard: it is a green number that describes a sample nobody chose. The count of
 * cameras with no measured evidence at all travels beside every aggregate.
 */
export const FleetProbeMetrics = z.object({
  window: HealthTrendWindow,
  windowStart: IsoDateTime,
  windowEnd: IsoDateTime,
  cameras: z.number().int().nonnegative(),
  /**
   * True when the aggregate was computed over a bounded sample rather than the whole estate
   * (P-2.3 rec 5). A sampled number presented as a census is worse than no number.
   */
  sampled: z.boolean().default(false),
  /** Cameras with at least one retained probe report in the window. */
  camerasProbed: z.number().int().nonnegative(),
  /** Cameras that have never been probed at all. The denominator nobody remembers to ask for. */
  camerasNeverProbed: z.number().int().nonnegative(),
  probes: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  successRatePercent: z.number().min(0).max(100).optional(),
  averageTotalMs: z.number().nonnegative().optional(),
  /** Per-stage averages across the fleet: average DNS, average negotiation, average first frame. */
  stages: z.array(ProbeStageMetric).max(13).default([]),
  /** The failure an installer is most likely to be looking at today. Absent when nothing failed. */
  mostCommonFailure: FailureDistributionEntry.optional(),
  failureBreakdown: z.array(FailureDistributionEntry).max(9).default([]),
  /** Firmware versions across the estate — the upgrade campaign, visible. */
  firmwareDistribution: z.array(DistributionEntry).max(20).default([]),
  /** Validation providers in use. */
  providerDistribution: z.array(DistributionEntry).max(16).default([]),
  /** Compatibility rows by status: supported / pending-validation / unsupported. */
  compatibilityDistribution: z.array(DistributionEntry).max(3).default([]),
  /** Mean operational confidence over the cameras that have enough evidence to have one. */
  averageConfidence: z.number().min(0).max(100).optional(),
  /** How many cameras contributed to `averageConfidence`. */
  confidenceSamples: z.number().int().nonnegative().default(0),
});
export type FleetProbeMetrics = z.infer<typeof FleetProbeMetrics>;
