/**
 * Application: camera-inventory use-cases (tenant-scoped via @vip/tenancy, fail-closed). This is
 * where credentials are vaulted: on create/update they are sealed with @vip/crypto and only the
 * cipher is persisted — plaintext never reaches the domain, the store, a log, or a response.
 *
 * Zone referential integrity: a camera references its `zoneId` (an `OrgNode` owned by the Tenant
 * context, P1-1). This slice validates the id's shape/tenant-scoping but does NOT synchronously
 * call the tenant service to confirm the node exists — cross-context reads go through the event
 * backbone (subscribe to `tenant.hierarchy.changed`, P1-5), keeping the contexts independently
 * deployable. Enforcing existence is tracked as tech-debt until the backbone lands (ED-0024/TD-3).
 */
import { CreateCameraInput } from '@vip/contracts';
import type {
  BulkCreateCamerasInput,
  BulkCreateCamerasResult,
  BulkCreateCameraResult,
  Camera,
  CameraCapabilities,
  CameraHealth,
  CameraHealthReport,
  CameraStatus,
  CameraValidationInput,
  CameraValidationResult,
  DiscoverCamerasInput,
  DiscoverCamerasResult,
  DiscoveredCamera,
  StreamConnection,
  UpdateCameraInput,
} from '@vip/contracts';
import type { TenantScope, TenantRepository } from '@vip/tenancy';
import type { SecretBox } from '@vip/crypto';
import { MongoServerError } from 'mongodb';
import {
  applyCameraUpdate,
  defaultCapabilities,
  defaultMetadata,
  newCamera,
  toCamera,
  validateCameraConfig,
  type Clock,
  type IdGen,
  type CameraDoc,
} from '../domain/camera.js';
import { badRequest, conflict, notFound } from './errors.js';
import { nullPublisher, type EventPublisher } from './events.js';
import { UnavailableDiscoveryProvider, type DiscoveryProvider } from './discovery.js';

const DUPLICATE_KEY = 11000;

/** Best-effort label for a bulk row that failed validation — an index alone is hard to act on. */
function nameOf(raw: unknown): string {
  const name = (raw as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name.length > 0 ? name.slice(0, 200) : '(unnamed)';
}

/**
 * Normalize a stream URL for comparison (P-1). Scheme and host are case-insensitive per RFC 3986;
 * the path is not, because plenty of DVRs serve case-sensitive channel paths. A trailing slash is
 * dropped — `/live` and `/live/` are the same endpoint and a false mismatch would have an installer
 * onboard a duplicate that then fails on the unique index.
 */
function normalizeStreamUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  const separator = trimmed.indexOf('://');
  if (separator < 0) return trimmed.toLowerCase();
  const scheme = trimmed.slice(0, separator).toLowerCase();
  const rest = trimmed.slice(separator + 3);
  const slash = rest.indexOf('/');
  if (slash < 0) return `${scheme}://${rest.toLowerCase()}`;
  return `${scheme}://${rest.slice(0, slash).toLowerCase()}${rest.slice(slash)}`;
}

export interface CameraServiceDeps {
  cameras: TenantRepository<CameraDoc>;
  vault: SecretBox;
  clock: Clock;
  ids: IdGen;
  publisher?: EventPublisher;
  /** Network discovery (P-1). Absent = a deployment that onboards from a list of URLs. */
  discovery?: DiscoveryProvider;
}

export class CameraService {
  private readonly cameras: TenantRepository<CameraDoc>;
  private readonly vault: SecretBox;
  private readonly clock: Clock;
  private readonly ids: IdGen;
  private readonly publisher: EventPublisher;
  private readonly discovery: DiscoveryProvider;

  constructor(deps: CameraServiceDeps) {
    this.cameras = deps.cameras;
    this.vault = deps.vault;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.publisher = deps.publisher ?? nullPublisher;
    this.discovery = deps.discovery ?? new UnavailableDiscoveryProvider();
  }

  /** Onboard a camera under the caller's tenant. Credentials (if any) are sealed before persistence. */
  async create(scope: TenantScope, input: CreateCameraInput): Promise<Camera> {
    const cipher = input.credentials ? this.vault.seal(JSON.stringify(input.credentials)) : null;
    const doc = newCamera(scope.tenantId, this.ids.cameraId(), input, cipher, this.clock.now());
    try {
      await this.cameras.insertOne(scope, doc);
    } catch (err) {
      if (err instanceof MongoServerError && err.code === DUPLICATE_KEY) {
        throw conflict(`a camera with this stream URL already exists in this tenant`);
      }
      throw err;
    }
    await this.publisher.publish({
      type: 'camera.registered',
      tenantId: scope.tenantId,
      payload: { cameraId: doc._id, zoneId: doc.zoneId, protocol: doc.protocol },
    });
    return toCamera(doc);
  }

  /** List the caller tenant's cameras (guard-isolated). Credentials are never included. */
  async list(scope: TenantScope): Promise<Camera[]> {
    const docs = await this.cameras.findMany(scope, {});
    return docs.map((d) => toCamera(d as CameraDoc));
  }

  /** Get one camera within scope, or 404 (also the cross-tenant response — no existence leak). */
  async get(scope: TenantScope, cameraId: string): Promise<Camera> {
    return toCamera(await this.require(scope, cameraId));
  }

  /** Update a camera. A new `streamUrl` must keep the (immutable) protocol's scheme. */
  async update(scope: TenantScope, cameraId: string, patch: UpdateCameraInput): Promise<Camera> {
    const existing = await this.require(scope, cameraId);
    if (patch.streamUrl && !patch.streamUrl.toLowerCase().startsWith(existing.protocol)) {
      throw badRequest(`streamUrl scheme must match protocol "${existing.protocol}"`);
    }
    const cipher = patch.credentials
      ? this.vault.seal(JSON.stringify(patch.credentials))
      : undefined;
    const updated = applyCameraUpdate(existing, patch, cipher, this.clock.now());
    await this.cameras.updateOne(
      scope,
      { _id: cameraId },
      {
        $set: {
          name: updated.name,
          zoneId: updated.zoneId,
          streamUrl: updated.streamUrl,
          status: updated.status,
          capture: updated.capture,
          // Backfill defaults so a pre-G-1 camera gains these fields on its next write.
          capabilities:
            updated.capabilities ?? defaultCapabilities(updated.protocol, updated.capture),
          metadata: updated.metadata ?? defaultMetadata(),
          credentialCipher: updated.credentialCipher,
          updatedAt: updated.updatedAt,
        },
      },
    );
    await this.publisher.publish({
      type: 'camera.updated',
      tenantId: scope.tenantId,
      payload: { cameraId, credentialsRotated: cipher !== undefined },
    });
    return toCamera(updated);
  }

  /** Remove a camera from the inventory (ingestion should stop consuming it). */
  async remove(scope: TenantScope, cameraId: string): Promise<void> {
    await this.require(scope, cameraId);
    await this.cameras.deleteOne(scope, { _id: cameraId });
    await this.publisher.publish({
      type: 'camera.removed',
      tenantId: scope.tenantId,
      payload: { cameraId },
    });
  }

  /** Report a camera's observed health (populated by the ingestion/health path in P1-4). */
  async health(scope: TenantScope, cameraId: string): Promise<CameraHealthReport> {
    const doc = await this.require(scope, cameraId);
    return { cameraId, ...doc.health };
  }

  /** A camera's declared capabilities (P2-2 G-1), defaulting for pre-G-1 documents. */
  async capabilities(scope: TenantScope, cameraId: string): Promise<CameraCapabilities> {
    const doc = await this.require(scope, cameraId);
    return doc.capabilities ?? defaultCapabilities(doc.protocol, doc.capture);
  }

  /** Validate a candidate configuration before onboarding (P2-2 G-1) — pure, no persistence. */
  validateConfig(input: CameraValidationInput): CameraValidationResult {
    return validateCameraConfig(input);
  }

  /**
   * Probe the network for ONVIF devices and reconcile the answers against this tenant (P-1).
   *
   * **Reconciliation is the part that matters.** A raw device list is nearly useless to an installer
   * re-scanning a site they half-configured last week: they cannot tell which of the twelve results
   * are already watched. So every device is matched against the tenant's existing cameras by stream
   * URL and marked `alreadyOnboarded` — shown, not hidden, because a device *missing* from the list
   * means it did not answer, and that is a different problem entirely.
   *
   * Discovery never persists anything. It returns candidates; onboarding is a separate, deliberate act.
   */
  async discover(scope: TenantScope, input: DiscoverCamerasInput): Promise<DiscoverCamerasResult> {
    const probe = await this.discovery.probe({ timeoutSeconds: input.timeoutSeconds });
    const existing = await this.cameras.findMany(scope, {});
    // Compare on the normalized URL: a device answering `RTSP://Cam.local:554/x` and a camera stored
    // as `rtsp://cam.local:554/x` are the same camera, and telling an installer otherwise would have
    // them onboard a duplicate that then fails on the unique index.
    const byUrl = new Map<string, CameraDoc>();
    for (const doc of existing as CameraDoc[]) {
      byUrl.set(normalizeStreamUrl(doc.streamUrl), doc);
    }

    const devices: DiscoveredCamera[] = probe.devices.map((device) => {
      const match = device.suggestedStreamUrl
        ? byUrl.get(normalizeStreamUrl(device.suggestedStreamUrl))
        : undefined;
      return {
        endpoint: device.endpoint,
        ...(device.address ? { address: device.address } : {}),
        metadata: device.metadata,
        capabilities: device.capabilities,
        ...(device.suggestedStreamUrl ? { suggestedStreamUrl: device.suggestedStreamUrl } : {}),
        ...(device.registryId ? { registryId: device.registryId } : {}),
        ...(device.warning ? { warning: device.warning } : {}),
        alreadyOnboarded: match !== undefined,
        ...(match ? { cameraId: match._id } : {}),
      };
    });

    return {
      devices,
      probedSeconds: probe.probedSeconds,
      ...(input.subnet ? { subnet: input.subnet } : {}),
      ...(probe.unavailable ? { unavailable: probe.unavailable } : {}),
    };
  }

  /**
   * Onboard several cameras in one call (P-1) — the DVR/NVR case, where one device publishes 8, 16
   * or 32 channels.
   *
   * **Partial success is the expected outcome, not an error.** One duplicate channel must not
   * discard the other fifteen, so each camera is created independently and its outcome recorded.
   * Wrapping this in a transaction would be worse: an installer who mistyped channel 7 would lose
   * the six that were right and have to do the whole DVR again.
   */
  async createMany(
    scope: TenantScope,
    input: BulkCreateCamerasInput,
  ): Promise<BulkCreateCamerasResult> {
    const results: BulkCreateCameraResult[] = [];
    for (const [index, raw] of input.cameras.entries()) {
      // Validated here, per item, rather than at the envelope — see BulkCreateCamerasInput. A
      // malformed row must be reported as a row, not turn the whole request into a 400.
      const parsed = CreateCameraInput.safeParse(raw);
      if (!parsed.success) {
        results.push({
          index,
          name: nameOf(raw),
          created: false,
          error: parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'camera'}: ${issue.message}`)
            .join('; ')
            .slice(0, 500),
        });
        continue;
      }
      const candidate = parsed.data;
      try {
        const camera = await this.create(scope, candidate);
        results.push({ index, name: candidate.name, created: true, camera });
      } catch (err) {
        results.push({
          index,
          name: candidate.name,
          created: false,
          error: err instanceof Error ? err.message : 'could not onboard this camera',
        });
      }
    }
    return {
      results,
      created: results.filter((r) => r.created).length,
      failed: results.filter((r) => !r.created).length,
    };
  }

  /** Validate an existing camera's stored configuration (P2-2 G-1). */
  async validateExisting(scope: TenantScope, cameraId: string): Promise<CameraValidationResult> {
    const doc = await this.require(scope, cameraId);
    return validateCameraConfig({
      protocol: doc.protocol,
      streamUrl: doc.streamUrl,
      capture: doc.capture,
      ...(doc.credentialCipher
        ? { credentials: { username: 'vaulted', password: 'vaulted' } }
        : {}),
    });
  }

  /**
   * Actively re-check a camera's health (P2-2 G-1) and record the snapshot. Deterministic: it runs
   * the configuration validation (no network). An invalid config → `unhealthy`; a valid config keeps
   * its current observed status (live connectivity is proven by ingestion, Media enabler G-2) but
   * refreshes `lastCheckedAt`. Returns the recorded report.
   */
  async checkHealth(scope: TenantScope, cameraId: string): Promise<CameraHealthReport> {
    const doc = await this.require(scope, cameraId);
    const result = validateCameraConfig({
      protocol: doc.protocol,
      streamUrl: doc.streamUrl,
      capture: doc.capture,
    });
    const at = this.clock.now().toISOString();
    const health: CameraHealth = result.valid
      ? { status: doc.health.status, lastCheckedAt: at }
      : {
          status: 'unhealthy',
          lastCheckedAt: at,
          detail: `configuration invalid: ${result.checks
            .filter((c) => !c.passed && !c.informational)
            .map((c) => c.name)
            .join(', ')}`,
        };
    await this.cameras.updateOne(scope, { _id: cameraId }, { $set: { health, updatedAt: at } });
    await this.publisher.publish({
      type: 'camera.health.checked',
      tenantId: scope.tenantId,
      payload: { cameraId, status: health.status },
    });
    return { cameraId, ...health };
  }

  /** Set a camera's administrative status (P2-2 G-1 enable/disable convenience). */
  async setStatus(scope: TenantScope, cameraId: string, status: CameraStatus): Promise<Camera> {
    const doc = await this.require(scope, cameraId);
    const at = this.clock.now().toISOString();
    await this.cameras.updateOne(scope, { _id: cameraId }, { $set: { status, updatedAt: at } });
    await this.publisher.publish({
      type: 'camera.updated',
      tenantId: scope.tenantId,
      payload: { cameraId, credentialsRotated: false },
    });
    return toCamera({ ...doc, status, updatedAt: at });
  }

  /**
   * Resolve a camera's stream connection descriptor, **decrypting its vaulted credentials** — the
   * single sanctioned decryption point. For internal service-to-service use only (media, P1-4);
   * never exposed on a user-facing route. The plaintext is returned transiently and never stored.
   */
  async resolveConnection(scope: TenantScope, cameraId: string): Promise<StreamConnection> {
    const doc = await this.require(scope, cameraId);
    const creds = doc.credentialCipher
      ? (JSON.parse(this.vault.open(doc.credentialCipher)) as {
          username: string;
          password: string;
        })
      : null;
    return {
      cameraId: doc._id,
      protocol: doc.protocol,
      streamUrl: doc.streamUrl,
      ...(creds ? { username: creds.username, password: creds.password } : {}),
    };
  }

  /** Fetch a camera within scope or throw 404 (shared by get/update/remove/health). */
  private async require(scope: TenantScope, cameraId: string): Promise<CameraDoc> {
    const doc = (await this.cameras.findOne(scope, { _id: cameraId })) as CameraDoc | null;
    if (!doc) throw notFound(`camera "${cameraId}" not found`);
    return doc;
  }
}
