/**
 * Application ports — the persistence seam for incidents, so the promotion + transition logic is
 * testable without Mongo. `IncidentStore` is intentionally thin (get/insert/replace/list + a
 * dedup-key lookup); all lifecycle logic lives in the domain factory + `IncidentService`, shared by
 * every adapter. Reads/writes are tenant-scoped structurally (via @vip/tenancy).
 */
import type { Incident, IncidentPage, IncidentQuery } from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';

export interface IncidentStore {
  /** Insert a freshly promoted incident. Throws a 409 `AppError` on a duplicate (tenant,id|dedupKey). */
  insert(scope: TenantScope, incident: Incident): Promise<void>;
  get(scope: TenantScope, id: string): Promise<Incident | null>;
  /** Look up an existing incident by its source dedup key (idempotent promotion). */
  getByDedupKey(scope: TenantScope, dedupKey: string): Promise<Incident | null>;
  list(scope: TenantScope, query: IncidentQuery): Promise<IncidentPage>;
  /**
   * Persist a transitioned incident, guarded by the previous version (optimistic concurrency).
   * Returns false if no row matched (id missing or version moved) — the caller retries/uses 409.
   */
  replace(scope: TenantScope, incident: Incident, expectedVersion: number): Promise<boolean>;
}
