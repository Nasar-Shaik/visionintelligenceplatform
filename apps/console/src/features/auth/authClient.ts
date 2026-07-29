import type { Principal } from '@vip/contracts';
import { permissionsForRoles } from '@vip/permissions';
import { store } from '@/app/store';
import { authenticating, authenticated, signedOut } from '@/store/sessionSlice';
import { authApi } from '@/lib/api/auth';
import { setAccessToken, setUnauthorizedHandler } from '@/lib/api/http';
import { tokenStore } from './tokenStore';

/**
 * Single owner of session mutation. Holds the access token in memory (via the http layer),
 * persists only the rotating refresh token (tokenStore), expands the principal's roles into
 * UI permission patterns (@vip/permissions), and dispatches session state to the store.
 * The UI (hooks/components) reads session via selectors and calls these functions.
 */

function applyPrincipal(principal: Principal): void {
  store.dispatch(
    authenticated({
      user: {
        id: principal.principalId,
        email: principal.email,
        roles: principal.roles,
      },
      tenantId: principal.tenantId,
      // /auth/me returns roles authoritatively; expand to permission patterns for deny-by-default
      // UI gating (the gateway remains the real authorization boundary).
      permissions: permissionsForRoles(principal.roles),
    }),
  );
}

function clearSession(): void {
  setAccessToken(null);
  tokenStore.clear();
  store.dispatch(signedOut());
}

let refreshInFlight: Promise<boolean> | null = null;

/** Single-flight silent refresh: concurrent callers share one in-flight request. */
export function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const run = (async () => {
    const refreshToken = tokenStore.getRefreshToken();
    const tenantId = tokenStore.getTenantId();
    if (!refreshToken || !tenantId) return false;
    try {
      const pair = await authApi.refresh(refreshToken);
      setAccessToken(pair.accessToken);
      tokenStore.save(pair.refreshToken, tenantId);
      return true;
    } catch {
      clearSession();
      return false;
    }
  })();
  refreshInFlight = run;
  // Release the latch once settled so a later 401 can refresh again.
  void run.finally(() => {
    if (refreshInFlight === run) refreshInFlight = null;
  });
  return run;
}

export const authClient = {
  /** Password login within a tenant. Persists the refresh token, hydrates the principal. */
  async login(
    tenantId: string,
    credentials: { email: string; password: string },
  ): Promise<Principal> {
    store.dispatch(authenticating());
    const pair = await authApi.login(tenantId, credentials);
    setAccessToken(pair.accessToken);
    tokenStore.save(pair.refreshToken, tenantId);
    const principal = await authApi.me();
    applyPrincipal(principal);
    return principal;
  },

  /** Best-effort server-side revoke, then always clear local session. */
  async logout(): Promise<void> {
    const refreshToken = tokenStore.getRefreshToken();
    try {
      if (refreshToken) await authApi.logout(refreshToken);
    } finally {
      clearSession();
    }
  },

  /** On app load: if a refresh token persists, silently mint an access token + hydrate. */
  async bootstrap(): Promise<void> {
    setUnauthorizedHandler(() => refreshSession());
    if (!tokenStore.getRefreshToken()) {
      store.dispatch(signedOut());
      return;
    }
    store.dispatch(authenticating());
    const ok = await refreshSession();
    if (!ok) return;
    try {
      applyPrincipal(await authApi.me());
    } catch {
      clearSession();
    }
  },
};
