/**
 * The Policy Decision Point (PDP). `can()` answers "does this set of granted patterns satisfy
 * the required permission?", honoring `*` wildcards. `principalCan()` expands a principal's roles
 * (+ any explicit permissions) and asks the same question — the single call every service uses
 * to gate an action. Deny-by-default: anything not explicitly granted is refused.
 */
import { ROLE_PERMISSIONS, isRole } from './model.js';

/** Split a `resource:action[:scope]` (or wildcard) into its segments. */
function segments(p: string): string[] {
  return p.split(':');
}

/** Does a single granted pattern satisfy the required permission? */
export function patternMatches(granted: string, required: string): boolean {
  if (granted === '*' || granted === required) return true;
  const g = segments(granted);
  const r = segments(required);
  // Compare segment-by-segment; a `*` in the grant matches any required segment. A grant with
  // fewer segments (e.g. `user:*`) covers a longer required (`user:read:tenant`) once matched.
  for (let i = 0; i < g.length; i++) {
    if (g[i] === '*') continue;
    if (g[i] !== r[i]) return false;
  }
  return true;
}

/** Does any granted pattern satisfy the required permission? */
export function can(granted: Iterable<string>, required: string): boolean {
  for (const g of granted) {
    if (patternMatches(g, required)) return true;
  }
  return false;
}

/** Expand roles to their granted permission patterns (unknown roles contribute nothing). */
export function permissionsForRoles(roles: readonly string[]): string[] {
  const out = new Set<string>();
  for (const role of roles) {
    if (isRole(role)) for (const p of ROLE_PERMISSIONS[role]) out.add(p);
  }
  return [...out];
}

export interface AuthzPrincipal {
  roles?: readonly string[];
  /** Explicit, concrete permissions granted directly (in addition to role-derived ones). */
  permissions?: readonly string[];
}

/** The gate every service calls: may this principal perform `required`? Deny-by-default. */
export function principalCan(principal: AuthzPrincipal, required: string): boolean {
  const granted = new Set<string>(principal.permissions ?? []);
  for (const p of permissionsForRoles(principal.roles ?? [])) granted.add(p);
  return can(granted, required);
}
