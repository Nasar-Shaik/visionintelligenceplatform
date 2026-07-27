/**
 * Tenant context — resolved for every request/operation and propagated across every hop
 * (docs/architecture/06-MULTI-TENANT-SAAS.md §2). No operation is possible without it (Law 5).
 */
import { z } from 'zod';
import { TenantId } from './primitives.js';

/** Scope levels a permission/assignment can apply to (docs/architecture/06 §3). */
export const Scope = z.enum(['own', 'zone', 'site', 'branch', 'region', 'tenant', 'global']);
export type Scope = z.infer<typeof Scope>;

/** A permission string `resource:action[:scope]` (docs/architecture/06 §3, 15 §2). */
export const Permission = z
  .string()
  .regex(/^[a-z0-9-]+:[a-z0-9-]+(?::[a-z0-9-]+)?$/, 'must be resource:action[:scope]');

export const TenantContext = z.object({
  tenantId: TenantId,
  /** Optional narrower scoping ids present on operational requests. */
  branchId: z.string().optional(),
  siteId: z.string().optional(),
  zoneId: z.string().optional(),
  cameraId: z.string().optional(),
  /** Authenticated principal (user or service account). */
  principalId: z.string(),
  roles: z.array(z.string()).default([]),
  permissions: z.array(Permission).default([]),
  /** Scopes the principal is granted (least-privilege). */
  scopes: z.array(Scope).default([]),
});
export type TenantContext = z.infer<typeof TenantContext>;
