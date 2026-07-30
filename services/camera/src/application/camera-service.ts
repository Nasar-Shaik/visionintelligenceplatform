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
import type {
  Camera,
  CameraCapabilities,
  CameraHealth,
  CameraHealthReport,
  CameraStatus,
  CameraValidationInput,
  CameraValidationResult,
  CreateCameraInput,
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

const DUPLICATE_KEY = 11000;

export interface CameraServiceDeps {
  cameras: TenantRepository<CameraDoc>;
  vault: SecretBox;
  clock: Clock;
  ids: IdGen;
  publisher?: EventPublisher;
}

export class CameraService {
  private readonly cameras: TenantRepository<CameraDoc>;
  private readonly vault: SecretBox;
  private readonly clock: Clock;
  private readonly ids: IdGen;
  private readonly publisher: EventPublisher;

  constructor(deps: CameraServiceDeps) {
    this.cameras = deps.cameras;
    this.vault = deps.vault;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.publisher = deps.publisher ?? nullPublisher;
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
