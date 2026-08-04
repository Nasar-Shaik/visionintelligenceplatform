import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateOrgNodeInput, UpdateOrgNodeInput, UpdateTenantInput } from '@vip/contracts';
import { organizationApi } from '@/lib/api/organization';
import { queryKeys } from '@/lib/queryKeys';
import { useSession } from '@/features/auth/useAuth';

/**
 * Estate reads and writes, scoped to the signed-in tenant.
 *
 * The tenant id comes from the session rather than the URL: the server refuses any path addressing
 * another tenant, so putting it in the address bar would only invite a 403 that looks like a bug.
 */
export function useOrgTree(under?: string) {
  const { tenantId } = useSession();
  return useQuery({
    queryKey: queryKeys.organization.tree(under),
    queryFn: () => organizationApi.tree(tenantId as string, under),
    enabled: Boolean(tenantId),
  });
}

/** The tenant record itself (P-6.3) — the settings screen's subject. */
export function useTenant() {
  const { tenantId } = useSession();
  return useQuery({
    queryKey: queryKeys.organization.tenant(tenantId ?? ''),
    queryFn: () => organizationApi.tenant(tenantId as string),
    enabled: Boolean(tenantId),
  });
}

/**
 * Rename the tenant.
 *
 * ⚠️ On success the tenant query is **replaced with the server's response and then invalidated**,
 * not patched optimistically. The server owns `updatedAt`, and `updatedAt` is the concurrency token
 * the next save sends back — so a locally-invented value would make the *following* edit conflict
 * against a version that never existed. The one place a stale cache would cause a wrong answer is
 * exactly the place optimistic UI is tempting.
 */
export function useUpdateTenant() {
  const { tenantId } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateTenantInput) =>
      organizationApi.updateTenant(tenantId as string, patch),
    onSuccess: (tenant) => {
      qc.setQueryData(queryKeys.organization.tenant(tenantId ?? ''), tenant);
      void qc.invalidateQueries({ queryKey: queryKeys.organization.tenant(tenantId ?? '') });
    },
    /*
     * ⚠️ A 409 means our copy is stale, so refetch immediately. The administrator's next action is
     * always "show me what it actually says now", and making them press reload to get it is making
     * them do the client's job.
     */
    onError: () =>
      void qc.invalidateQueries({ queryKey: queryKeys.organization.tenant(tenantId ?? '') }),
  });
}

/** A bounded page of resolved locations — used by pickers and filters. */
export function useLocations(params: Record<string, string | number | boolean> = {}) {
  const { tenantId } = useSession();
  return useQuery({
    queryKey: queryKeys.organization.locations(params),
    queryFn: () => organizationApi.locations(tenantId as string, params),
    enabled: Boolean(tenantId),
  });
}

/** One resolved location, breadcrumb included. Resolves for archived locations too. */
export function useLocation(nodeId: string | undefined) {
  const { tenantId } = useSession();
  return useQuery({
    queryKey: queryKeys.organization.location(nodeId ?? ''),
    queryFn: () => organizationApi.location(tenantId as string, nodeId as string),
    enabled: Boolean(tenantId && nodeId),
  });
}

function useEstateMutation<TVars>(run: (tenantId: string, vars: TVars) => Promise<unknown>) {
  const { tenantId } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: TVars) => run(tenantId as string, vars),
    // A move rewrites descendants and an archive cascades, so the whole estate is invalidated
    // rather than one node. Guessing which nodes changed here would be re-deriving the traversal
    // the backend just did.
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.organization.all() }),
  });
}

export function useCreateLocation() {
  return useEstateMutation<CreateOrgNodeInput>((tenantId, input) =>
    organizationApi.create(tenantId, input),
  );
}

export function useUpdateLocation() {
  return useEstateMutation<{ nodeId: string; patch: UpdateOrgNodeInput }>((tenantId, vars) =>
    organizationApi.update(tenantId, vars.nodeId, vars.patch),
  );
}

export function useArchiveLocation() {
  return useEstateMutation<string>((tenantId, nodeId) => organizationApi.archive(tenantId, nodeId));
}

export function useRestoreLocation() {
  return useEstateMutation<string>((tenantId, nodeId) => organizationApi.restore(tenantId, nodeId));
}
