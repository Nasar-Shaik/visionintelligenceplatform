import type {
  CreateOrgNodeInput,
  OrgLocation,
  OrgLocationPage,
  OrgNode,
  OrgTree,
  Tenant,
  UpdateOrgNodeInput,
  UpdateTenantInput,
} from '@vip/contracts';
import { http } from './http';

/**
 * The customer's estate — locations, not devices (through the gateway: `/api/tenant/*`).
 *
 * Every read here arrives **already resolved**: breadcrumb, depth, label and the child types a node
 * accepts are computed by the service. The console renders them and never re-derives them, so the
 * containment rules live in exactly one place (`docs/architecture/PLATFORM_BOUNDARIES.md` rule 3).
 *
 * There is deliberately no `remove`. Locations are archived, never deleted — historical evidence
 * references them by id long after a reorganisation, and a delete would turn an old investigation
 * into a dangling id.
 */
export const organizationApi = {
  /** The tenant record itself — name, slug, status, timestamps. */
  tenant: (tenantId: string) => http.get<Tenant>(`/tenant/tenants/${tenantId}`),

  /**
   * Rename the tenant (or move its lifecycle).
   *
   * ⚠️ `expectedUpdatedAt` is always sent. It is optional in the contract so that callers older
   * than P-6.3 keep working, but a console that omitted it would let one administrator's change
   * silently replace another's — and the loser would never find out.
   */
  updateTenant: (tenantId: string, patch: UpdateTenantInput) =>
    http.patch<Tenant>(`/tenant/tenants/${tenantId}`, patch),

  tree: (tenantId: string, under?: string) =>
    http.get<OrgTree>(
      `/tenant/tenants/${tenantId}/org-tree${under ? `?under=${encodeURIComponent(under)}` : ''}`,
    ),

  locations: (tenantId: string, params: Record<string, string | number | boolean> = {}) => {
    const query = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)]),
    ).toString();
    return http.get<OrgLocationPage>(
      `/tenant/tenants/${tenantId}/locations${query ? `?${query}` : ''}`,
    );
  },

  location: (tenantId: string, nodeId: string) =>
    http.get<OrgLocation>(`/tenant/tenants/${tenantId}/locations/${nodeId}`),

  create: (tenantId: string, input: CreateOrgNodeInput) =>
    http.post<OrgNode>(`/tenant/tenants/${tenantId}/org-nodes`, input),

  /** Rename and/or move. A node's `type` is immutable and is not accepted here. */
  update: (tenantId: string, nodeId: string, patch: UpdateOrgNodeInput) =>
    http.patch<OrgLocation>(`/tenant/tenants/${tenantId}/org-nodes/${nodeId}`, patch),

  archive: (tenantId: string, nodeId: string) =>
    http.post<OrgLocation>(`/tenant/tenants/${tenantId}/org-nodes/${nodeId}/archive`, {}),

  restore: (tenantId: string, nodeId: string) =>
    http.post<OrgLocation>(`/tenant/tenants/${tenantId}/org-nodes/${nodeId}/restore`, {}),
};
