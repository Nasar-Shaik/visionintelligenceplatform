import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateOrgNodeInput, UpdateOrgNodeInput } from '@vip/contracts';
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
