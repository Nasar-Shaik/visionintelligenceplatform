/**
 * @vip/tenancy — the fail-closed multi-tenant data-layer guard (Law 5).
 *
 * Isolation is structural, not conventional: a service holds a `TenantScope` and drives every
 * read/write through `TenantRepository`, which injects and enforces `tenantId`. A missing or
 * mismatched tenant context throws `TenancyError` and the operation is refused — a forgotten
 * filter cannot leak data across tenants.
 *
 * Grounds: docs/architecture/06-MULTI-TENANT-SAAS.md, 18-DATA-ARCHITECTURE.md,
 * docs/architecture/phase1/TENANT_ARCHITECTURE.md, ADR-0003.
 *
 * Usage:
 *   const scope = TenantScope.fromContext(request.tenantContext);
 *   const tenants = new TenantRepository<TenantDoc>(db.collection('tenants'));
 *   await tenants.insertOne(scope, doc);   // tenantId stamped + enforced
 *   await tenants.findMany(scope, {});     // tenantId injected — never cross-tenant
 */
export { TenancyError } from './errors.js';
export { TenantScope, TENANT_KEY } from './scope.js';
export {
  scopedFilter,
  scopedInsert,
  scopedPipeline,
  guardUpdate,
  assertOwned,
  type PlainObject,
} from './guard.js';
export { TenantRepository, type TenantScoped } from './repository.js';

/** Package version — bump per Constitution §7. */
export const TENANCY_VERSION = '0.1.0';
