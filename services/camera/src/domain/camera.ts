/**
 * Domain: pure camera record construction + transitions. Framework-free and deterministic — id
 * generation and the clock are injected. Credentials are handled as an ALREADY-SEALED opaque
 * cipher string (the application layer owns the SecretBox); the domain never sees plaintext and
 * `toCamera` never returns the cipher. Shapes conform to the @vip/contracts `Camera` schema.
 */
import type {
  Camera,
  CameraProtocol,
  CameraStatus,
  CaptureProfile,
  CameraHealth,
  CreateCameraInput,
  UpdateCameraInput,
} from '@vip/contracts';
import type { TenantScoped } from '@vip/tenancy';

/** MongoDB-persisted camera document. `_id` is the camera id; `tenantId` scopes it (Law 5). */
export interface CameraDoc extends TenantScoped {
  _id: string;
  zoneId: string;
  name: string;
  protocol: CameraProtocol;
  streamUrl: string;
  status: CameraStatus;
  capture: CaptureProfile;
  health: CameraHealth;
  /** Sealed credentials envelope (@vip/crypto), or null when none are vaulted. Never returned. */
  credentialCipher: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Clock {
  now(): Date;
}

export interface IdGen {
  cameraId(): string;
}

const DEFAULT_CAPTURE: CaptureProfile = { ptz: false };
const INITIAL_HEALTH: CameraHealth = { status: 'unknown' };

/**
 * Build a new camera document (administratively `enabled`, health `unknown` until first probed).
 * `credentialCipher` is the sealed envelope from the application layer, or null.
 */
export function newCamera(
  tenantId: string,
  id: string,
  input: CreateCameraInput,
  credentialCipher: string | null,
  at: Date,
): CameraDoc {
  const ts = at.toISOString();
  return {
    _id: id,
    tenantId,
    zoneId: input.zoneId,
    name: input.name,
    protocol: input.protocol,
    streamUrl: input.streamUrl,
    status: 'enabled',
    capture: input.capture ?? DEFAULT_CAPTURE,
    health: INITIAL_HEALTH,
    credentialCipher,
    createdAt: ts,
    updatedAt: ts,
  };
}

/**
 * Apply an update, bumping `updatedAt`. `newCredentialCipher` is:
 *   - `undefined` → credentials unchanged,
 *   - a string    → re-vaulted credentials (sealed envelope),
 * mirroring whether `patch.credentials` was supplied.
 */
export function applyCameraUpdate(
  doc: CameraDoc,
  patch: UpdateCameraInput,
  newCredentialCipher: string | undefined,
  at: Date,
): CameraDoc {
  return {
    ...doc,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.zoneId !== undefined ? { zoneId: patch.zoneId } : {}),
    ...(patch.streamUrl !== undefined ? { streamUrl: patch.streamUrl } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.capture !== undefined ? { capture: patch.capture } : {}),
    ...(newCredentialCipher !== undefined ? { credentialCipher: newCredentialCipher } : {}),
    updatedAt: at.toISOString(),
  };
}

/** Map a persisted camera to its public contract shape — credentials reduced to `hasCredentials`. */
export function toCamera(doc: CameraDoc): Camera {
  return {
    id: doc._id,
    tenantId: doc.tenantId,
    zoneId: doc.zoneId,
    name: doc.name,
    protocol: doc.protocol,
    streamUrl: doc.streamUrl,
    status: doc.status,
    capture: doc.capture,
    health: doc.health,
    hasCredentials: doc.credentialCipher !== null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
