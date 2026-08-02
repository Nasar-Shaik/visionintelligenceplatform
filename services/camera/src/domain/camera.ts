/**
 * Domain: pure camera record construction + transitions. Framework-free and deterministic — id
 * generation and the clock are injected. Credentials are handled as an ALREADY-SEALED opaque
 * cipher string (the application layer owns the SecretBox); the domain never sees plaintext and
 * `toCamera` never returns the cipher. Shapes conform to the @vip/contracts `Camera` schema.
 */
import type {
  Camera,
  CameraCapabilities,
  CameraDeviceIdentity,
  CameraIdentityChange,
  CameraLifecycle,
  CameraOperationalHealth,
  CameraTimelineEntry,
  CapabilityCache,
  CompatibilityRecord,
  CameraMetadata,
  CameraProtocol,
  CameraStatus,
  CaptureProfile,
  CameraHealth,
  CameraValidationCheck,
  CameraValidationInput,
  CameraValidationResult,
  CreateCameraInput,
  UpdateCameraInput,
} from '@vip/contracts';
import type { TenantScoped } from '@vip/tenancy';
import { declaredCache } from './capability-cache.js';
import { derivedLifecycle, initialLifecycle } from './lifecycle.js';

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
  /** What the camera supports (P2-2 G-1). Optional on read for pre-G-1 documents. */
  capabilities?: CameraCapabilities;
  /** Operator/device metadata (P2-2 G-1). Optional on read for pre-G-1 documents. */
  metadata?: CameraMetadata;
  /** Operational state (P-2). Optional on read for pre-P-2 documents; derived when absent. */
  lifecycle?: CameraLifecycle;
  /** Bounded operational history (P-2). */
  timeline?: CameraTimelineEntry[];
  /** Stable device identity (P-2). Absent until a device has identified itself. */
  identity?: CameraDeviceIdentity;
  /** Append-only record of every identity change (P-2.1). Never overwritten. */
  identityHistory?: CameraIdentityChange[];
  /** Provenance of the cached capabilities (P-2). */
  capabilityCache?: CapabilityCache;
  /** Last measured device health (P-2). Absent means nothing has ever probed this camera. */
  operational?: CameraOperationalHealth;
  /** Compatibility history (P-2.2). Every condition this camera has run under. */
  compatibility?: CompatibilityRecord[];
  /** Probes ever run (P-2.2). Monotonic — distinct from how many reports are still retained. */
  probeCount?: number;
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
  /** Identifier for one immutable probe report (P-2.2). */
  probeId(): string;
}

const DEFAULT_CAPTURE: CaptureProfile = { ptz: false };
const INITIAL_HEALTH: CameraHealth = { status: 'unknown' };

/** Derive default capabilities from the transport + capture profile (P2-2 G-1). */
export function defaultCapabilities(
  protocol: CameraProtocol,
  capture: CaptureProfile,
): CameraCapabilities {
  return {
    ptz: capture.ptz,
    audio: false,
    snapshot: true,
    codecs: capture.codec ? [capture.codec] : [],
    resolutions: capture.resolution ? [capture.resolution] : [],
    protocols: [protocol],
    // AI-5c: derived from the capture profile where it is known, so the inference runtime can READ
    // capabilities instead of probing the device. `fpsRange` stays absent until discovery or an
    // operator supplies it — an invented range would be worse than none, because the runtime would
    // clamp against a number nobody verified.
    streamProfiles: [],
    onvif: false,
    // AI-5e: whether the device offers an ONVIF metadata stream. Like `onvif`, it stays false until
    // discovery confirms it — a capability nobody verified is not a capability.
    metadataStream: false,
  };
}

/** Empty operator metadata (tags default to `[]`). */
export function defaultMetadata(): CameraMetadata {
  return { tags: [] };
}

/**
 * Validate a candidate camera configuration deterministically (P2-2 G-1, "test connection"). Pure —
 * no network I/O. `valid` is the AND of the non-informational checks. Active reachability is
 * reported as an *informational* check only; proving live connectivity is the ingestion path's job
 * (Media enabler G-2), so it never fails validation here.
 */
export function validateCameraConfig(input: CameraValidationInput): CameraValidationResult {
  const url = input.streamUrl.trim();
  const lower = url.toLowerCase();
  const checks: CameraValidationCheck[] = [];

  const schemeOk = /^(rtsps?|rtmps?):\/\//.test(lower);
  checks.push({
    name: 'stream-url-scheme',
    passed: schemeOk,
    informational: false,
    ...(schemeOk ? {} : { message: 'must be an rtsp:// or rtmp:// URL' }),
  });

  const noEmbedded = !/^[a-z]+:\/\/[^/@]*@/i.test(lower);
  checks.push({
    name: 'no-embedded-credentials',
    passed: noEmbedded,
    informational: false,
    ...(noEmbedded
      ? {}
      : { message: 'credentials must not be embedded in the URL — pass them in `credentials`' }),
  });

  const protoMatch = lower.startsWith(input.protocol);
  checks.push({
    name: 'protocol-matches-url',
    passed: protoMatch,
    informational: false,
    ...(protoMatch ? {} : { message: `URL scheme must match protocol "${input.protocol}"` }),
  });

  const resOk = !input.capture?.resolution || /^\d{2,5}x\d{2,5}$/.test(input.capture.resolution);
  checks.push({
    name: 'capture-resolution-format',
    passed: resOk,
    informational: false,
    ...(resOk ? {} : { message: 'capture.resolution must be WIDTHxHEIGHT, e.g. 1920x1080' }),
  });

  const valid = checks.every((c) => c.passed);

  // Informational only — does not affect `valid`.
  checks.push({
    name: 'credentials-present',
    passed: Boolean(input.credentials),
    informational: true,
    message: input.credentials
      ? 'credentials supplied'
      : 'no credentials supplied (fine for open streams)',
  });
  checks.push({
    name: 'reachability',
    passed: true,
    informational: true,
    message: 'not probed — live connectivity is verified by ingestion (Media enabler G-2)',
  });

  return { valid, checks };
}

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
  const capture = input.capture ?? DEFAULT_CAPTURE;
  return {
    _id: id,
    tenantId,
    zoneId: input.zoneId,
    name: input.name,
    protocol: input.protocol,
    streamUrl: input.streamUrl,
    status: 'enabled',
    capture,
    health: INITIAL_HEALTH,
    // Capabilities: use the operator's declaration, else derive from protocol + capture (P2-2 G-1).
    capabilities: input.capabilities ?? defaultCapabilities(input.protocol, capture),
    metadata: input.metadata ?? defaultMetadata(),
    // P-2: a new camera has a configuration and nothing measured. It reaches `connected` only when
    // a probe against the physical device says so — never at onboarding.
    lifecycle: initialLifecycle(at),
    timeline: [
      {
        at: ts,
        kind: 'state-changed',
        evidence: 'declared',
        reasonCode: 'onboarded',
        to: 'configured',
        detail: 'onboarded',
      },
    ],
    // Empty either way: capabilities supplied at onboarding are *declared*, and a declaration is
    // not a device read. `discoveredAt` stays absent until something actually asks the camera.
    capabilityCache: declaredCache(),
    // P-2: carried from discovery when it is known. This is what makes the camera recognisable at a
    // new address later — identity recorded at onboarding or not at all.
    ...(input.identity ? { identity: input.identity } : {}),
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
    ...(patch.capabilities !== undefined ? { capabilities: patch.capabilities } : {}),
    ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
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
    // Default for pre-G-1 documents so every response satisfies the (now-required) contract fields.
    capabilities: doc.capabilities ?? defaultCapabilities(doc.protocol, doc.capture),
    metadata: doc.metadata ?? defaultMetadata(),
    // P-2: derived for pre-P-2 documents rather than left absent — a state machine every consumer
    // has to null-check is a state machine nobody relies on.
    lifecycle: doc.lifecycle ?? derivedLifecycle(doc.createdAt),
    timeline: doc.timeline ?? [],
    ...(doc.identity ? { identity: doc.identity } : {}),
    identityHistory: doc.identityHistory ?? [],
    ...(doc.capabilityCache ? { capabilityCache: doc.capabilityCache } : {}),
    ...(doc.operational ? { operational: doc.operational } : {}),
    compatibility: doc.compatibility ?? [],
    probeCount: doc.probeCount ?? 0,
    hasCredentials: doc.credentialCipher !== null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
