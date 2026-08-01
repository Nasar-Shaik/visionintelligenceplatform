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
