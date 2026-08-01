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
});
export type CameraMetadata = z.infer<typeof CameraMetadata>;

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
export const CameraTimelineEntry = z.object({
  at: IsoDateTime,
  kind: CameraTimelineEventKind,
  evidence: LifecycleEvidence,
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
});
export type CapabilityCache = z.infer<typeof CapabilityCache>;

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
  /** Provenance of the cached capabilities (P-2) — what they were read against, and when. */
  capabilityCache: CapabilityCache.optional(),
  /**
   * Last measured device health (P-2). Absent means **nothing has ever probed this camera** — which
   * is different from, and must never be rendered as, a camera that was probed and found offline.
   */
  operational: CameraOperationalHealth.optional(),
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
export const StreamProbeCheckName = z.enum([
  'reachability',
  'authentication',
  'stream-open',
  'frames-received',
  'codec',
  'resolution',
  'fps',
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
  status: z.enum(['pass', 'fail', 'warn', 'not-executed']),
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
export const CameraHealthSummary = z.object({
  cameraId: z.string().min(1),
  windowStart: IsoDateTime,
  windowEnd: IsoDateTime,
  /** How many timeline entries this summary was computed from. */
  observations: z.number().int().nonnegative(),
  /** Share of the window spent in a healthy state. Absent when too little was observed to say. */
  availabilityPercent: z.number().min(0).max(100).optional(),
  /** Transitions back into a healthy state — the flapping signal. */
  reconnects: z.number().int().nonnegative(),
  credentialFailures: z.number().int().nonnegative(),
  offlineSeconds: z.number().int().nonnegative(),
  averageLatencyMs: z.number().nonnegative().optional(),
  capabilityRefreshes: z.number().int().nonnegative(),
  firmwareChanges: z.number().int().nonnegative(),
});
export type CameraHealthSummary = z.infer<typeof CameraHealthSummary>;
