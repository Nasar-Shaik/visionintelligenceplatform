/**
 * Pure guard transforms — the heart of tenant isolation. These functions take a TenantScope
 * and a query/document/update and return a tenant-bound version, throwing (fail-closed) on any
 * attempt to read, write, or mutate across the tenant boundary. They are storage-agnostic and
 * fully unit-testable without a database; the TenantRepository applies them to MongoDB.
 */
import { TenancyError } from './errors.js';
import { TENANT_KEY, type TenantScope } from './scope.js';

export type PlainObject = Record<string, unknown>;

/**
 * Inject `tenantId` into a read/write filter. If the caller already set a tenantId, it must
 * equal the scope's — a mismatch is an attempt to reach another tenant and is refused.
 */
export function scopedFilter(scope: TenantScope, filter: PlainObject = {}): PlainObject {
  const existing = filter[TENANT_KEY];
  if (existing !== undefined && existing !== scope.tenantId) {
    throw new TenancyError(
      `filter tenantId "${String(existing)}" does not match scope "${scope.tenantId}" (fail-closed)`,
    );
  }
  return { ...filter, [TENANT_KEY]: scope.tenantId };
}

/**
 * Stamp `tenantId` onto a document for insertion. A document that already carries a different
 * tenantId is refused (fail-closed) rather than silently overwritten.
 */
export function scopedInsert<T extends PlainObject>(
  scope: TenantScope,
  doc: T,
): T & { tenantId: string } {
  const existing = doc[TENANT_KEY];
  if (existing !== undefined && existing !== scope.tenantId) {
    throw new TenancyError(
      `document tenantId "${String(existing)}" does not match scope "${scope.tenantId}" (fail-closed)`,
    );
  }
  return { ...doc, [TENANT_KEY]: scope.tenantId };
}

/**
 * Reject any update that would change or remove `tenantId`. A record can never be moved between
 * tenants. Covers `$set`/`$setOnInsert` reassignment, `$unset`, and replacement-style top-level.
 */
export function guardUpdate(scope: TenantScope, update: PlainObject): void {
  for (const op of ['$set', '$setOnInsert'] as const) {
    const clause = update[op];
    if (isObject(clause) && TENANT_KEY in clause && clause[TENANT_KEY] !== scope.tenantId) {
      throw new TenancyError('an update may not reassign tenantId (fail-closed)');
    }
  }
  const unset = update['$unset'];
  if (isObject(unset) && TENANT_KEY in unset) {
    throw new TenancyError('an update may not remove tenantId (fail-closed)');
  }
  if (TENANT_KEY in update && update[TENANT_KEY] !== scope.tenantId) {
    throw new TenancyError('an update may not reassign tenantId (fail-closed)');
  }
}

/**
 * Assert a record that was read/loaded belongs to the scope. Belt-and-braces for code paths
 * that fetch by a store-native id and must re-check ownership before returning it.
 */
export function assertOwned(
  scope: TenantScope,
  record: { tenantId?: unknown } | null | undefined,
): void {
  if (record == null) return;
  if (record.tenantId !== scope.tenantId) {
    throw new TenancyError('record belongs to another tenant (fail-closed)');
  }
}

/** Prefix an aggregation pipeline with a leading tenant `$match` so stages can't widen scope. */
export function scopedPipeline(scope: TenantScope, pipeline: PlainObject[] = []): PlainObject[] {
  return [{ $match: { [TENANT_KEY]: scope.tenantId } }, ...pipeline];
}

function isObject(v: unknown): v is PlainObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
