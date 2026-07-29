/**
 * Refresh-token persistence for silent re-auth across reloads. The **access token stays
 * in memory only** (never persisted — XSS-safe); only the rotating refresh token + the
 * tenant slug are persisted so a returning user can silently mint a new access token.
 *
 * NOTE: browser localStorage is used for the SPA refresh flow. A future hardening step is
 * an httpOnly refresh cookie issued by the gateway (a backend enabler) — tracked as a
 * follow-up; until then this is the pragmatic SPA approach. Falls back to an in-memory map
 * when storage is unavailable (private mode / test env).
 */
const REFRESH_KEY = 'vip.console.refreshToken';
const TENANT_KEY = 'vip.console.tenantId';

function safeStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  try {
    const s = globalThis.localStorage;
    // Probe — some environments expose the object but throw on access.
    const probe = '__vip_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    const mem = new Map<string, string>();
    return {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => void mem.set(k, v),
      removeItem: (k) => void mem.delete(k),
    };
  }
}

const storage = safeStorage();

export const tokenStore = {
  getRefreshToken: (): string | null => storage.getItem(REFRESH_KEY),
  getTenantId: (): string | null => storage.getItem(TENANT_KEY),
  save(refreshToken: string, tenantId: string): void {
    storage.setItem(REFRESH_KEY, refreshToken);
    storage.setItem(TENANT_KEY, tenantId);
  },
  clear(): void {
    storage.removeItem(REFRESH_KEY);
    storage.removeItem(TENANT_KEY);
  },
};
