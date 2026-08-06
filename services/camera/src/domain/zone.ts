/**
 * Domain: **detection zones** in the camera context (P-8 Phase 7 §Zones).
 *
 * Pure construction and versioning, in the shape `domain/assignment.ts` established: a stored
 * document, a set of total functions that turn an input into the next document, and an immutable
 * snapshot per change. No I/O.
 *
 * ### ⚠️ Why the camera context owns zones
 *
 * A zone is a polygon on **one camera's image plane**. It is meaningless without that camera, it is
 * invalidated by that camera being re-aimed, and it must be deleted when that camera is. Those are
 * the properties of camera configuration, and the alternative — a zone service, or zones inside the
 * rules service — would have put the geometry a rule needs on the far side of a boundary from the
 * camera it describes, and would have needed a new service, which the standing guardrails forbid.
 *
 * ### ⚠️ Why the version history is not optional
 *
 * `docs` are edited; incidents are not. An incident raised in March names a zone and a version, and
 * the detail page must be able to draw **that** polygon over **that** footage. Without the snapshot it
 * would draw today's, confidently, over old video — and be wrong in a way that looks exactly like
 * being right. See `DetectionZoneVersionRecord`.
 */
import {
  isEvaluableShape,
  validateZoneGeometry,
  ZONE_EVALUATION,
  ZONE_LIMITS,
  type CreateDetectionZoneInput,
  type DetectionZone,
  type DetectionZoneVersionRecord,
  type UpdateDetectionZoneInput,
  type ZoneGeometry,
  type ZoneGeometryProblem,
  type ZoneKind,
  type ZoneShape,
} from '@vip/contracts';

/** The stored form. `_id` is `tenantId:zoneId`, so a tenant can never read another's zone by id. */
export interface ZoneDoc {
  _id: string;
  tenantId: string;
  zoneId: string;
  cameraId: string;
  name: string;
  description?: string;
  kind: ZoneKind;
  shape: ZoneShape;
  geometry: ZoneGeometry;
  purpose?: string;
  enabled: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  updatedBy?: string;
  attributes: Record<string, unknown>;
}

/** The stored version snapshot. `_id` is `tenantId:zoneId:version` — idempotent on replay. */
export interface ZoneVersionDoc {
  _id: string;
  tenantId: string;
  zoneId: string;
  version: number;
  changeKind: DetectionZoneVersionRecord['changeKind'];
  changedBy?: string;
  changedAt: Date;
  snapshot: DetectionZone;
}

export function zoneDocId(tenantId: string, zoneId: string): string {
  return `${tenantId}:${zoneId}`;
}

export function zoneVersionDocId(tenantId: string, zoneId: string, version: number): string {
  return `${tenantId}:${zoneId}:${version}`;
}

/** Why a zone could not be created or updated. */
export type ZoneRefusal =
  | { kind: 'geometry'; problems: ZoneGeometryProblem[] }
  | { kind: 'too-many-zones'; limit: number }
  | { kind: 'duplicate-name'; name: string }
  /** A shape the platform can store but not evaluate — see `ZONE_EVALUATION` (Architect rec 2). */
  | { kind: 'shape-not-evaluable'; shape: ZoneShape; needs: string };

export interface ZoneDeps {
  now: () => Date;
  newId: () => string;
}

/**
 * Check a proposed geometry.
 *
 * ⚠️ **`shape` is checked against `kind`, not trusted.** A `rectangle` with five points is either a
 * console bug or a hand-written request, and either way the editor would later re-open it with corner
 * handles and silently discard the fifth point. Refusing here is the only place that has both facts.
 */
export function checkGeometry(
  geometry: ZoneGeometry,
  kind: ZoneKind,
  shape: ZoneShape,
): ZoneGeometryProblem[] {
  const problems = validateZoneGeometry(geometry, kind);
  /*
   * ⚠️ `kind` must match what the shape implies. A `rectangle` declared as `kind: line` would pass
   * the ≥2-points check, be stored, and then be skipped by the resolver — a zone the operator drew,
   * saw filled in, and that silently evaluates nothing.
   */
  const expectedKind = ZONE_EVALUATION[shape].kind;
  if (kind !== expectedKind) {
    problems.push({
      code: 'degenerate',
      message: `a ${shape} must have kind "${expectedKind}", not "${kind}"`,
    });
  }
  if (shape === 'rectangle' && geometry.points.length !== 4) {
    problems.push({
      code: 'degenerate',
      message: `a rectangle is stored as exactly 4 corner points, got ${geometry.points.length}`,
    });
  }
  return problems;
}

export function createZone(
  tenantId: string,
  input: CreateDetectionZoneInput,
  existingOnCamera: readonly ZoneDoc[],
  deps: ZoneDeps,
  actor?: string,
): { doc: ZoneDoc; version: ZoneVersionDoc } | { refusal: ZoneRefusal } {
  /*
   * ⚠️ Refused at creation, not skipped at evaluation. A `path` zone the platform cannot evaluate is
   * configuration that silently does nothing — the operator draws it, saves it, sees it in the list,
   * and never learns why no incident arrives. Reserving the value in the contract while refusing to
   * store one is the honest combination: the shape fits without redesign, and nobody can use it yet.
   */
  if (!isEvaluableShape(input.shape)) {
    return {
      refusal: {
        kind: 'shape-not-evaluable',
        shape: input.shape,
        needs: ZONE_EVALUATION[input.shape].needs ?? 'an evaluator',
      },
    };
  }
  const problems = checkGeometry(input.geometry, input.kind, input.shape);
  if (problems.length > 0) return { refusal: { kind: 'geometry', problems } };
  if (existingOnCamera.length >= ZONE_LIMITS.maxZonesPerCamera) {
    return { refusal: { kind: 'too-many-zones', limit: ZONE_LIMITS.maxZonesPerCamera } };
  }
  /*
   * ⚠️ Names are unique per camera. Two zones called "Checkout" on one camera produce incidents
   * nobody can tell apart — the id distinguishes them and the id is not what an operator reads.
   */
  const clash = existingOnCamera.find(
    (z) => z.name.trim().toLowerCase() === input.name.trim().toLowerCase(),
  );
  if (clash !== undefined) return { refusal: { kind: 'duplicate-name', name: input.name } };

  const at = deps.now();
  const zoneId = deps.newId();
  const doc: ZoneDoc = {
    _id: zoneDocId(tenantId, zoneId),
    tenantId,
    zoneId,
    cameraId: input.cameraId,
    name: input.name.trim(),
    kind: input.kind,
    shape: input.shape,
    geometry: input.geometry,
    enabled: input.enabled,
    version: 1,
    createdAt: at,
    updatedAt: at,
    attributes: input.attributes,
  };
  if (input.description !== undefined) doc.description = input.description;
  if (input.purpose !== undefined) doc.purpose = input.purpose;
  if (actor !== undefined) doc.updatedBy = actor;
  return { doc, version: versionOf(doc, 'created', actor, at) };
}

/** Which kind of change this patch is — the word that ends up in the history. */
function changeKindOf(
  patch: UpdateDetectionZoneInput,
  before: ZoneDoc,
): DetectionZoneVersionRecord['changeKind'] {
  if (patch.geometry !== undefined) return 'geometry-changed';
  if (patch.enabled !== undefined && patch.enabled !== before.enabled) {
    return patch.enabled ? 'enabled' : 'disabled';
  }
  if (patch.name !== undefined) return 'renamed';
  return 'geometry-changed';
}

export function updateZone(
  existing: ZoneDoc,
  patch: UpdateDetectionZoneInput,
  siblings: readonly ZoneDoc[],
  deps: ZoneDeps,
  actor?: string,
): { doc: ZoneDoc; version: ZoneVersionDoc } | { refusal: ZoneRefusal } {
  const kind = patch.kind ?? existing.kind;
  const shape = patch.shape ?? existing.shape;
  const geometry = patch.geometry ?? existing.geometry;
  const problems = checkGeometry(geometry, kind, shape);
  if (problems.length > 0) return { refusal: { kind: 'geometry', problems } };

  if (patch.name !== undefined) {
    const wanted = patch.name.trim().toLowerCase();
    const clash = siblings.find(
      (z) => z.zoneId !== existing.zoneId && z.name.trim().toLowerCase() === wanted,
    );
    if (clash !== undefined) return { refusal: { kind: 'duplicate-name', name: patch.name } };
  }

  const at = deps.now();
  const doc: ZoneDoc = {
    ...existing,
    kind,
    shape,
    geometry,
    version: existing.version + 1,
    updatedAt: at,
  };
  if (patch.name !== undefined) doc.name = patch.name.trim();
  if (patch.description !== undefined) doc.description = patch.description;
  if (patch.purpose !== undefined) doc.purpose = patch.purpose;
  if (patch.enabled !== undefined) doc.enabled = patch.enabled;
  if (patch.attributes !== undefined) doc.attributes = patch.attributes;
  if (actor !== undefined) doc.updatedBy = actor;

  return { doc, version: versionOf(doc, changeKindOf(patch, existing), actor, at) };
}

export function versionOf(
  doc: ZoneDoc,
  changeKind: DetectionZoneVersionRecord['changeKind'],
  actor: string | undefined,
  at: Date,
): ZoneVersionDoc {
  const version: ZoneVersionDoc = {
    _id: zoneVersionDocId(doc.tenantId, doc.zoneId, doc.version),
    tenantId: doc.tenantId,
    zoneId: doc.zoneId,
    version: doc.version,
    changeKind,
    changedAt: at,
    snapshot: toZoneContract(doc),
  };
  if (actor !== undefined) version.changedBy = actor;
  return version;
}

export function toZoneContract(doc: ZoneDoc): DetectionZone {
  const zone: DetectionZone = {
    id: doc.zoneId,
    tenantId: doc.tenantId,
    cameraId: doc.cameraId,
    name: doc.name,
    kind: doc.kind,
    shape: doc.shape,
    geometry: doc.geometry,
    enabled: doc.enabled,
    version: doc.version,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    attributes: doc.attributes,
  };
  if (doc.description !== undefined) zone.description = doc.description;
  if (doc.purpose !== undefined) zone.purpose = doc.purpose;
  if (doc.updatedBy !== undefined) zone.updatedBy = doc.updatedBy;
  return zone;
}

export function toVersionContract(doc: ZoneVersionDoc): DetectionZoneVersionRecord {
  const record: DetectionZoneVersionRecord = {
    tenantId: doc.tenantId,
    zoneId: doc.zoneId,
    version: doc.version,
    changeKind: doc.changeKind,
    changedAt: doc.changedAt.toISOString(),
    snapshot: doc.snapshot,
  };
  if (doc.changedBy !== undefined) record.changedBy = doc.changedBy;
  return record;
}
