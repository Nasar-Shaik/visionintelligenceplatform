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
