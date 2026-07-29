import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppSelector } from '@/app/hooks';
import { authClient } from './authClient';

/** Read the current session (client state; deny-by-default gating uses `usePermission`). */
export function useSession() {
  const session = useAppSelector((state) => state.session);
  return {
    ...session,
    isAuthenticated: session.status === 'authenticated',
  };
}

export interface LoginVars {
  tenantId: string;
  email: string;
  password: string;
}

/** Login mutation — hydrates the session on success; surfaces `ApiRequestError` on failure. */
export function useLogin() {
  return useMutation({
    mutationFn: ({ tenantId, email, password }: LoginVars) =>
      authClient.login(tenantId, { email, password }),
  });
}

/** Logout mutation — revokes server-side, clears local session, drops all cached server state. */
export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => authClient.logout(),
    onSettled: () => queryClient.clear(),
  });
}
