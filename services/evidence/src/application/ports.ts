/**
 * Application ports (hexagonal) — the seams the Evidence service depends on. Adapters implement them
 * (in-memory for tests, Mongo for prod; @vip/storage `ObjectStore` for bytes). Kept small + focused
 * (interface-segregation): the store owns the manifest, the custody log is append-only, the storage
 * provider is the untenanted object store the service wraps per-tenant.
 */
import type { EvidenceQuery } from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import type { EvidenceDoc } from '../domain/evidence.js';
import type { CustodyDoc } from '../domain/custody.js';

/** Persistence for evidence manifests (tenant-scoped, idempotent on the stable id). */
export interface EvidenceStore {
  /** Insert if absent; returns false if an item with this id already exists (idempotent register). */
  insert(scope: TenantScope, doc: EvidenceDoc): Promise<boolean>;
  get(scope: TenantScope, id: string): Promise<EvidenceDoc | null>;
  list(
    scope: TenantScope,
    query: EvidenceQuery,
  ): Promise<{ items: EvidenceDoc[]; nextCursor?: string }>;
  /** Replace the mutable overlay/lifecycle fields (metadata/ai/status/retention/media.tier/updatedAt). */
  patch(scope: TenantScope, id: string, fields: Partial<EvidenceDoc>): Promise<boolean>;
}

/** Append-only, hash-chained chain-of-custody. */
export interface CustodyLog {
  append(scope: TenantScope, entry: CustodyDoc): Promise<void>;
  /** The latest entry for an item (for the next seq + prevHash), or null if none. */
  head(scope: TenantScope, evidenceId: string): Promise<CustodyDoc | null>;
  /** All entries for an item, oldest-first (paged). */
  list(
    scope: TenantScope,
    evidenceId: string,
    opts: { limit: number; cursor?: string },
  ): Promise<{ items: CustodyDoc[]; nextCursor?: string }>;
}
