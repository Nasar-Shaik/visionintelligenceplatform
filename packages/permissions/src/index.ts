/**
 * @vip/permissions — the authorization model + Policy Decision Point (deny-by-default).
 *
 * Services never hand-roll permission checks: they call `principalCan(context, 'user:read')`.
 * Roles expand to wildcard-aware permission patterns here; the full Policy Engine (docs 28,
 * ADR-0013) plugs in behind this same surface in Phase 3 without touching call sites.
 *
 * Grounds: docs/architecture/06-MULTI-TENANT-SAAS.md §3, 15-SECURITY-ARCHITECTURE.md,
 * 28-POLICY-ENGINE.md, docs/architecture/phase1/AUTHENTICATION.md.
 */
export { ROLE_PERMISSIONS, ROLES, isRole, type Role } from './model.js';
export {
  can,
  patternMatches,
  permissionsForRoles,
  principalCan,
  type AuthzPrincipal,
} from './can.js';

/** Package version — bump per Constitution §7. */
export const PERMISSIONS_VERSION = '0.1.0';
