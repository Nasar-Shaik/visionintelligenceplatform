/**
 * TenantScope — a validated, non-empty tenant identity that every guarded operation requires.
 * Constructing one is the single choke point where "no tenant context" fails closed
 * (docs/architecture/phase1/TENANT_ARCHITECTURE.md §5). Once you hold a TenantScope, the
 * guard guarantees every read/write it drives is bound to exactly this tenant.
 */
import type { TenantContext } from '@vip/contracts';
import { TenancyError } from './errors.js';

/** The reserved discriminator field carried by every tenant-scoped record. */
export const TENANT_KEY = 'tenantId' as const;

export class TenantScope {
  readonly tenantId: string;

  private constructor(tenantId: string) {
    this.tenantId = tenantId;
  }

  /** Build a scope from a raw id. Throws (fail-closed) if it is missing or blank. */
  static fromTenantId(tenantId: string | null | undefined): TenantScope {
    if (typeof tenantId !== 'string' || tenantId.trim() === '') {
      throw new TenancyError('no tenant context: a non-empty tenantId is required (fail-closed)');
    }
    return new TenantScope(tenantId);
  }

  /** Build a scope from a resolved TenantContext. Throws (fail-closed) if absent. */
  static fromContext(ctx: Pick<TenantContext, 'tenantId'> | null | undefined): TenantScope {
    if (!ctx) throw new TenancyError('no tenant context provided (fail-closed)');
    return TenantScope.fromTenantId(ctx.tenantId);
  }
}
