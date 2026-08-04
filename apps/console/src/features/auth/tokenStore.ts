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
    clearInvestigativeResidue();
  },
};

/**
 * Per-operator state that must not outlive a session on a shared workstation.
 *
 * ⚠️ Found in P-5.8 by logging out of the production deployment and reading `localStorage`. The
 * tokens were cleared correctly — an access token is never persisted at all — but
 * `vip.workspace.state.<tenant>.<principal>` survived, and it holds the principal id and **the
 * incident ids the operator had open**. On a shared SOC terminal that tells the next person who was
 * here and what they were investigating. It is not evidence, so nothing was cached outside approved
 * storage; it is investigative metadata, and it has no reason to persist past sign-out.
 *
 * ⚠️ Cleared on logout, not disabled: surviving a page refresh is the whole point of the workspace
 * state (P-5.2), and a session that ends is exactly the boundary where it should stop — the same
 * rule the playback preferences already follow ("within the current investigation session only").
 *
 * Prefix-matched rather than keyed by principal, because at logout the caller may no longer know
 * which principal it was, and leaving one behind would defeat the purpose.
 */
const RESIDUE_PREFIXES = ['vip.workspace.state.'];

function clearInvestigativeResidue(): void {
  try {
    const local = globalThis.localStorage;
    if (local === undefined) return;
    const doomed: string[] = [];
    for (let i = 0; i < local.length; i += 1) {
      const key = local.key(i);
      if (key !== null && RESIDUE_PREFIXES.some((prefix) => key.startsWith(prefix)))
        doomed.push(key);
    }
    for (const key of doomed) local.removeItem(key);
  } catch {
    /* Storage unavailable (private browsing, disabled) — nothing persisted, nothing to clear. */
  }
}
