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
  CameraHealthReport,
  CreateCameraInput,
  UpdateCameraInput,
} from '@vip/contracts';
import type { TenantScope, TenantRepository } from '@vip/tenancy';
import type { SecretBox } from '@vip/crypto';
import { MongoServerError } from 'mongodb';
import {
  applyCameraUpdate,
  newCamera,
  toCamera,
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

  /** Fetch a camera within scope or throw 404 (shared by get/update/remove/health). */
  private async require(scope: TenantScope, cameraId: string): Promise<CameraDoc> {
    const doc = (await this.cameras.findOne(scope, { _id: cameraId })) as CameraDoc | null;
    if (!doc) throw notFound(`camera "${cameraId}" not found`);
    return doc;
  }
}
