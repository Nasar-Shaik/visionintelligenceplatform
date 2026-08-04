import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateUserInput, UpdateUserInput } from '@vip/contracts';
import { usersApi } from '@/lib/api/users';
import { queryKeys } from '@/lib/queryKeys';

/**
 * User administration reads and writes.
 *
 * There is no tenant id in any of these calls, and that is deliberate: identity resolves the tenant
 * from the access token's claims, so the console cannot ask about another tenant even by accident.
 * (Contrast the estate endpoints, which carry `tenantId` in the path for historical reasons.)
 */
export function useUsers() {
  return useQuery({
    queryKey: queryKeys.users.list(),
    queryFn: () => usersApi.list(),
  });
}

/**
 * Every write invalidates the whole namespace rather than patching the affected row.
 *
 * The list is one unpaged request and a disable changes two fields plus a server-set `updatedAt`;
 * reconstructing that here would mean re-deriving a timestamp the server just wrote, which is the
 * kind of second source of truth that goes wrong silently.
 */
function useUserMutation<TVars, TResult>(run: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.users.all() }),
  });
}

export function useCreateUser() {
  return useUserMutation((input: CreateUserInput) => usersApi.create(input));
}

export function useUpdateUser() {
  return useUserMutation((vars: { userId: string; patch: UpdateUserInput }) =>
    usersApi.update(vars.userId, vars.patch),
  );
}

export function useDisableUser() {
  return useUserMutation((userId: string) => usersApi.disable(userId));
}

export function useEnableUser() {
  return useUserMutation((userId: string) => usersApi.enable(userId));
}

export function useSetUserPassword() {
  return useUserMutation((vars: { userId: string; password: string }) =>
    usersApi.setPassword(vars.userId, vars.password),
  );
}
