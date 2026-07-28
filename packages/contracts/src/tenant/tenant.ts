/**
 * Tenant + organizational-hierarchy contracts (Phase 1, P1-1).
 * The tenant is the root of all data; every record carries its `tenantId` (Law 5).
 * Grounds: docs/architecture/06-MULTI-TENANT-SAAS.md, 18-DATA-ARCHITECTURE.md,
 * docs/architecture/phase1/TENANT_ARCHITECTURE.md.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId } from '../common/primitives.js';

/**
 * Tenant lifecycle (docs/architecture/phase1/TENANT_ARCHITECTURE.md §1):
 * provisioning → active → (suspended ↔ active) → deprovisioning.
 */
export const TenantStatus = z.enum(['provisioning', 'active', 'suspended', 'deprovisioning']);
export type TenantStatus = z.infer<typeof TenantStatus>;

/**
 * DNS-safe tenant slug (also usable as a key/namespace prefix): lowercase alphanumeric +
 * internal hyphens, 3–40 chars. Stable for the life of the tenant.
 */
export const TenantSlug = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, 'must be dns-safe: [a-z0-9-], 3–40 chars');
export type TenantSlug = z.infer<typeof TenantSlug>;

/** A tenant record as persisted/returned. */
export const Tenant = z.object({
  id: TenantId,
  slug: TenantSlug,
  name: z.string().min(1).max(200),
  status: TenantStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Tenant = z.infer<typeof Tenant>;

/** Input to create a tenant (server assigns id/status/timestamps). */
export const CreateTenantInput = z.object({
  slug: TenantSlug,
  name: z.string().min(1).max(200),
});
export type CreateTenantInput = z.infer<typeof CreateTenantInput>;

/** Input to update a tenant (name and/or lifecycle transition). */
export const UpdateTenantInput = z
  .object({
    name: z.string().min(1).max(200).optional(),
    status: TenantStatus.optional(),
  })
  .refine((v) => v.name !== undefined || v.status !== undefined, {
    message: 'at least one of name or status is required',
  });
export type UpdateTenantInput = z.infer<typeof UpdateTenantInput>;

/**
 * Organizational hierarchy node types (docs/architecture/phase1/TENANT_ARCHITECTURE.md,
 * CAMERA_ARCHITECTURE.md): `org → region → country → branch → site → building → floor → zone`.
 * The camera leaf is modeled by the camera contracts (P1-3), not here.
 */
export const OrgNodeType = z.enum([
  'org',
  'region',
  'country',
  'branch',
  'site',
  'building',
  'floor',
  'zone',
]);
export type OrgNodeType = z.infer<typeof OrgNodeType>;

/**
 * A node in a tenant's location tree. The `org` root has `parentId: null`. `path` is the
 * materialized list of ancestor ids (root-first, excluding self) for subtree queries.
 */
export const OrgNode = z.object({
  id: z.string().min(1),
  tenantId: TenantId,
  parentId: z.string().min(1).nullable(),
  type: OrgNodeType,
  name: z.string().min(1).max(200),
  path: z.array(z.string().min(1)).default([]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrgNode = z.infer<typeof OrgNode>;

/** Input to create an org node (root `org` is created with `parentId: null`). */
export const CreateOrgNodeInput = z.object({
  type: OrgNodeType,
  name: z.string().min(1).max(200),
  parentId: z.string().min(1).nullable(),
});
export type CreateOrgNodeInput = z.infer<typeof CreateOrgNodeInput>;
