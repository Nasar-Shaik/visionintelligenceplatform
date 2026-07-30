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
 * What a camera/stream supports (P2-2 G-1). Declared at onboarding — defaults are derived from the
 * protocol + capture profile — and editable by an operator; later populated by discovery/ONVIF.
 * Drives the console's Live Monitoring / PTZ affordances without decoding the stream.
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

/** Input to the (stubbed) ONVIF/network discovery endpoint. */
export const DiscoverCamerasInput = z.object({
  /** CIDR to scan, e.g. "10.0.0.0/24". Optional until discovery is implemented. */
  subnet: z.string().max(64).optional(),
});
export type DiscoverCamerasInput = z.infer<typeof DiscoverCamerasInput>;

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
