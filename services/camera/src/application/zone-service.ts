/**
 * Application: **detection zone configuration** (P-8 Phase 7 §Zones).
 *
 * CRUD plus the two reads nothing else can answer: the zones a camera's plan entry carries, and the
 * scope resolution the rules service needs at validation time.
 *
 * ⚠️ Every write bumps the platform-wide **zone version**, which is what the assignment plan carries
 * and what makes an edit reach the enforcement point within one poll. It is deliberately a *separate*
 * counter from the assignment version — see `AssignmentPlanEntry.zoneVersion` for why dragging a
 * vertex must not look like a reassignment.
 */
import type { Collection } from 'mongodb';
import {
  toPlanZone,
  ZONE_LIMITS,
  type CreateDetectionZoneInput,
  type DetectionZone,
  type DetectionZoneVersionRecord,
  type PlanZone,
  type UpdateDetectionZoneInput,
} from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import {
  createZone,
  toVersionContract,
  toZoneContract,
  updateZone,
  versionOf,
  zoneDocId,
  type ZoneDoc,
  type ZoneRefusal,
  type ZoneVersionDoc,
} from '../domain/zone.js';
import { badRequest, conflict, notFound } from './errors.js';

/** What the rules service asked about, and what the camera context found (P-8 Phase 7). */
export interface ScopeResolutionResult {
  cameras: { missing: string[] };
  groups: { cameraIds: string[]; missing: string[]; empty: string[] };
  zones: { missing: string[]; disabled: string[]; cameraIds: Record<string, string> };
}

export interface ZoneServiceDeps {
  zones: Collection<ZoneDoc>;
  zoneVersions: Collection<ZoneVersionDoc>;
  cameras: Collection<{ _id: string; tenantId: string }>;
  groups: Collection<{ _id: string; tenantId: string; groupId: string; cameraIds: string[] }>;
  /** Called after any write, so the assignment plan's `zoneVersion` moves and media re-polls. */
  onZonesChanged: () => void;
  now?: () => Date;
  newId?: () => string;
}

export class ZoneService {
  readonly #zones: Collection<ZoneDoc>;
  readonly #versions: Collection<ZoneVersionDoc>;
  readonly #cameras: ZoneServiceDeps['cameras'];
  readonly #groups: ZoneServiceDeps['groups'];
  readonly #onChanged: () => void;
  readonly #now: () => Date;
  readonly #newId: () => string;

  constructor(deps: ZoneServiceDeps) {
    this.#zones = deps.zones;
    this.#versions = deps.zoneVersions;
    this.#cameras = deps.cameras;
    this.#groups = deps.groups;
    this.#onChanged = deps.onZonesChanged;
    this.#now = deps.now ?? (() => new Date());
    this.#newId = deps.newId ?? (() => `zn-${crypto.randomUUID().slice(0, 12)}`);
  }

  async list(scope: TenantScope, cameraId?: string): Promise<DetectionZone[]> {
    const filter =
      cameraId === undefined
        ? { tenantId: scope.tenantId }
        : { tenantId: scope.tenantId, cameraId };
    const docs = await this.#zones.find(filter as never).toArray();
    return docs.map(toZoneContract).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(scope: TenantScope, zoneId: string): Promise<DetectionZone> {
    const doc = await this.#zones.findOne({ _id: zoneDocId(scope.tenantId, zoneId) } as never);
    if (doc === null) throw notFound(`zone ${zoneId} not found`);
    return toZoneContract(doc);
  }

  /** Every version of a zone, newest first — what an incident detail page resolves against. */
  async versions(scope: TenantScope, zoneId: string): Promise<DetectionZoneVersionRecord[]> {
    const docs = await this.#versions
      .find({ tenantId: scope.tenantId, zoneId } as never)
      .sort({ version: -1 })
      .toArray();
    return docs.map(toVersionContract);
  }

  /**
   * One historical version.
   *
   * ⚠️ The route an incident detail page calls. It returns the geometry **as it was**, which is the
   * whole reason the history exists — see `DetectionZoneVersionRecord`.
   */
  async versionAt(
    scope: TenantScope,
    zoneId: string,
    version: number,
  ): Promise<DetectionZoneVersionRecord> {
    const doc = await this.#versions.findOne({
      tenantId: scope.tenantId,
      zoneId,
      version,
    } as never);
    if (doc === null) throw notFound(`zone ${zoneId} has no version ${version}`);
    return toVersionContract(doc);
  }

  async create(
    scope: TenantScope,
    input: CreateDetectionZoneInput,
    actor?: string,
  ): Promise<DetectionZone> {
    const camera = await this.#cameras.findOne({
      _id: input.cameraId,
      tenantId: scope.tenantId,
    } as never);
    if (camera === null) throw notFound(`camera ${input.cameraId} not found`);

    const siblings = await this.#zones
      .find({ tenantId: scope.tenantId, cameraId: input.cameraId } as never)
      .toArray();
    const outcome = createZone(
      scope.tenantId,
      input,
      siblings,
      { now: this.#now, newId: this.#newId },
      actor,
    );
    if ('refusal' in outcome) throw refusalError(outcome.refusal);

    await this.#zones.insertOne(outcome.doc as never);
    await this.#versions.insertOne(outcome.version as never);
    this.#onChanged();
    return toZoneContract(outcome.doc);
  }

  async update(
    scope: TenantScope,
    zoneId: string,
    patch: UpdateDetectionZoneInput,
    actor?: string,
  ): Promise<DetectionZone> {
    const existing = await this.#zones.findOne({ _id: zoneDocId(scope.tenantId, zoneId) } as never);
    if (existing === null) throw notFound(`zone ${zoneId} not found`);
    const siblings = await this.#zones
      .find({ tenantId: scope.tenantId, cameraId: existing.cameraId } as never)
      .toArray();

    const outcome = updateZone(
      existing,
      patch,
      siblings,
      { now: this.#now, newId: this.#newId },
      actor,
    );
    if ('refusal' in outcome) throw refusalError(outcome.refusal);

    await this.#zones.replaceOne({ _id: outcome.doc._id } as never, outcome.doc as never);
    await this.#versions.insertOne(outcome.version as never);
    this.#onChanged();
    return toZoneContract(outcome.doc);
  }

  /**
   * Delete a zone.
   *
   * ⚠️ **The version history is deliberately NOT deleted.** An incident that names this zone must
   * still resolve the geometry that produced it; removing the history would turn every past incident
   * on this zone into an unrenderable record. A final `deleted` snapshot is appended so the history
   * ends with a fact rather than trailing off.
   */
  async remove(scope: TenantScope, zoneId: string, actor?: string): Promise<void> {
    const existing = await this.#zones.findOne({ _id: zoneDocId(scope.tenantId, zoneId) } as never);
    if (existing === null) throw notFound(`zone ${zoneId} not found`);
    const at = this.#now();
    const tombstone = versionOf(
      { ...existing, version: existing.version + 1, updatedAt: at },
      'deleted',
      actor,
      at,
    );
    await this.#versions.insertOne(tombstone as never);
    await this.#zones.deleteOne({ _id: existing._id } as never);
    this.#onChanged();
  }

  /**
   * The enabled zones for every camera, keyed by camera — what the assignment plan carries.
   *
   * ⚠️ **Cross-tenant, one query.** The plan is cross-tenant for the reason recorded on
   * `AssignmentPlan`, and building it must not become N queries as the estate grows. Disabled zones
   * are filtered here so the enforcement point never has to check a flag it could forget to check.
   */
  async planZonesByCamera(): Promise<Map<string, PlanZone[]>> {
    const docs = await this.#zones.find({ enabled: true } as never).toArray();
    const byCamera = new Map<string, PlanZone[]>();
    for (const doc of docs) {
      const key = `${doc.tenantId}:${doc.cameraId}`;
      const list = byCamera.get(key) ?? [];
      list.push(toPlanZone(toZoneContract(doc)));
      byCamera.set(key, list);
    }
    /* Deterministic order, so an unchanged zone set produces an unchanged plan document. */
    for (const list of byCamera.values()) list.sort((a, b) => a.zoneId.localeCompare(b.zoneId));
    return byCamera;
  }

  /** A compact catalog for the rules service's synchronous name/version lookup. */
  async catalog(): Promise<{ tenantId: string; zoneId: string; name: string; version: number }[]> {
    const docs = await this.#zones.find({} as never).toArray();
    return docs.map((d) => ({
      tenantId: d.tenantId,
      zoneId: d.zoneId,
      name: d.name,
      version: d.version,
    }));
  }

  /**
   * Answer the rules service's validation-time scope questions in **one** round trip.
   *
   * ⚠️ One call rather than three, and that is not micro-optimisation. Validation happens while an
   * operator waits on a save; three sequential cross-service calls is three chances for one to be
   * slow and three different partial-failure states for the report to describe. One call has one
   * answer or no answer, and "no answer" is already a first-class outcome (`available: false`).
   */
  async resolveScope(
    scope: TenantScope,
    request: { cameraIds?: string[]; groupIds?: string[]; zoneIds?: string[] },
  ): Promise<ScopeResolutionResult> {
    const cameraIds = request.cameraIds ?? [];
    const groupIds = request.groupIds ?? [];
    const zoneIds = request.zoneIds ?? [];

    const result: ScopeResolutionResult = {
      cameras: { missing: [] },
      groups: { cameraIds: [], missing: [], empty: [] },
      zones: { missing: [], disabled: [], cameraIds: {} },
    };

    if (cameraIds.length > 0) {
      const found = await this.#cameras
        .find({ _id: { $in: cameraIds }, tenantId: scope.tenantId } as never, {
          projection: { _id: 1 },
        })
        .toArray();
      const present = new Set(found.map((c) => String(c._id)));
      result.cameras.missing = cameraIds.filter((id) => !present.has(id));
    }

    if (groupIds.length > 0) {
      const found = await this.#groups
        .find({ groupId: { $in: groupIds }, tenantId: scope.tenantId } as never)
        .toArray();
      const byId = new Map(found.map((g) => [g.groupId, g]));
      const expanded = new Set<string>();
      for (const groupId of groupIds) {
        const group = byId.get(groupId);
        if (group === undefined) {
          result.groups.missing.push(groupId);
          continue;
        }
        if (group.cameraIds.length === 0) {
          result.groups.empty.push(groupId);
          continue;
        }
        for (const cameraId of group.cameraIds) expanded.add(cameraId);
      }
      result.groups.cameraIds = [...expanded].sort();
    }

    if (zoneIds.length > 0) {
      const found = await this.#zones
        .find({ zoneId: { $in: zoneIds }, tenantId: scope.tenantId } as never)
        .toArray();
      const byId = new Map(found.map((z) => [z.zoneId, z]));
      for (const zoneId of zoneIds) {
        const zone = byId.get(zoneId);
        if (zone === undefined) {
          result.zones.missing.push(zoneId);
          continue;
        }
        if (!zone.enabled) result.zones.disabled.push(zoneId);
        result.zones.cameraIds[zoneId] = zone.cameraId;
      }
    }

    return result;
  }

  /**
   * Drop every zone belonging to a deleted camera.
   *
   * ⚠️ Exists because P-8 Phase 6 shipped a defect of exactly this shape: a deleted camera's
   * assignment consumed runtime capacity for ever, because nothing swept it. A deleted camera's zones
   * would be worse — they would stay in the plan, be evaluated against frames from a camera that no
   * longer exists, and appear in the zone editor's list with no camera to draw them on.
   */
  async releaseCamera(tenantId: string, cameraId: string, actor?: string): Promise<number> {
    const docs = await this.#zones.find({ tenantId, cameraId } as never).toArray();
    if (docs.length === 0) return 0;
    const at = this.#now();
    for (const doc of docs) {
      await this.#versions.insertOne(
        versionOf(
          { ...doc, version: doc.version + 1, updatedAt: at },
          'deleted',
          actor,
          at,
        ) as never,
      );
    }
    await this.#zones.deleteMany({ tenantId, cameraId } as never);
    this.#onChanged();
    return docs.length;
  }
}

function refusalError(refusal: ZoneRefusal): Error {
  switch (refusal.kind) {
    case 'geometry':
      return badRequest(
        `zone geometry is not valid: ${refusal.problems.map((p) => p.message).join('; ')}`,
      );
    case 'too-many-zones':
      return conflict(
        `a camera may have at most ${ZONE_LIMITS.maxZonesPerCamera} zones (this one is full)`,
      );
    case 'duplicate-name':
      return conflict(`this camera already has a zone called "${refusal.name}"`);
    case 'shape-not-evaluable':
      return badRequest(
        `"${refusal.shape}" zones can be described but not yet evaluated by this platform — ` +
          `it needs ${refusal.needs}. Use a polygon or a rectangle.`,
      );
  }
}
