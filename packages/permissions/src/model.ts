/**
 * The RBAC model: a canonical set of roles, each granting a set of permission *patterns*.
 * A required permission is a concrete `resource:action[:scope]` string (the @vip/contracts
 * `Permission` shape); a granted pattern may use `*` wildcards (`user:*`, `*:read`, `*`).
 * This is the Phase-1 subset; the full attribute/policy engine (docs 28) plugs in behind
 * `@vip/permissions` in Phase 3 without changing call sites.
 */

/** Canonical Phase-1 roles. Tenant-defined roles can be layered on later. */
export type Role = 'owner' | 'admin' | 'operator' | 'viewer';

/**
 * Role → granted permission patterns. Wildcards keep the catalog small:
 *   `*`         — everything
 *   `res:*`     — every action on `res`
 *   `*:read`    — read on every resource
 */
export const ROLE_PERMISSIONS: Record<Role, readonly string[]> = {
  owner: ['*'],
  admin: [
    'user:*',
    'org:*',
    'camera:*',
    'stream:*',
    'rule:*',
    'incident:*',
    'notification:*',
    'evidence:*',
    'event:read',
    'event:replay',
    'tenant:read',
    'tenant:update',
  ],
  operator: [
    '*:read',
    'stream:control',
    'incident:ack',
    'incident:resolve',
    'notification:ack',
    'evidence:create',
    'evidence:update',
  ],
  viewer: ['*:read'],
};

export const ROLES = Object.keys(ROLE_PERMISSIONS) as Role[];

export function isRole(value: string): value is Role {
  return value in ROLE_PERMISSIONS;
}
