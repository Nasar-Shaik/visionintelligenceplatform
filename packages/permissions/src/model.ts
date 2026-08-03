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
    // P-5.0 G-1/G-2 — the investigation workflow is an operator's job, not an admin's.
    'incident:investigate',
    'incident:escalate',
    'incident:assign',
    'incident:comment',
    // P-5.1 — attaching evidence and exporting an investigation are operator work.
    'incident:attach',
    'incident:export',
    /*
     * ⚠️ `incident:close` is **granted**, and that is deliberate.
     *
     * Closing used to require `incident:resolve`; splitting it lets a tenant enforce separation of
     * duties — the person who fixes a thing and the person who signs it off are often different.
     * But *withholding* it here would silently remove an ability every operator has today, which is
     * a breaking behaviour change dressed as a new permission. So the split is additive: behaviour
     * is unchanged, and a tenant that wants the separation revokes this one grant.
     */
    'incident:close',
    'notification:ack',
    'evidence:create',
    'evidence:update',
  ],
  viewer: ['*:read'],
};

/**
 * The incident permission catalog (P-5.1), stated as data so the AI boundary is checkable.
 *
 * Names keep the platform's `resource:action` form. The recommendation wrote them with dots
 * (`incident.view`); renaming `incident:read` to match would break every token, policy and runbook
 * in exchange for punctuation — CONSTRAINTS §41, and §55 on structural separation not being a
 * rewrite. The spelling is the only thing that differs.
 */
export const INCIDENT_PERMISSIONS = [
  'incident:read',
  'incident:ack',
  'incident:assign',
  'incident:comment',
  'incident:attach',
  'incident:investigate',
  'incident:escalate',
  'incident:resolve',
  'incident:close',
  'incident:export',
  /**
   * ⚠️ Reserved, granted to **no role**. The read-side grant a future AI advisor would hold. It
   * permits producing an `IncidentRecommendation` and nothing else.
   */
  'incident:ai-recommend',
] as const;

/**
 * ⚠️ **Permissions deliberately NOT created, because each would authorise something an approved
 * invariant forbids.** Listed rather than silently omitted, so the next reader knows the omission
 * was a decision.
 *
 * - `incident:create` — incidents are **only** promoted from a rule candidate. A create route would
 *   make the automation flow one source among several, and an incident with no `source.candidateId`
 *   cannot answer "why does this exist".
 * - `incident:reopen` — a closed incident is **sealed** (CONSTRAINTS §57). "Retained for audit" is
 *   only true if the record stops changing. Work that resumes after closure is a new incident,
 *   linked by `correlationId`.
 * - `incident:delete` — the history is immutable. Deleting an incident destroys the audit trail
 *   that is the point of keeping it. Retention expiry is the Evidence context's mechanism.
 * - `incident:admin` — `incident:*` already expresses it; a second spelling of a wildcard is a
 *   second thing to keep in sync.
 * - `incident:ai-resolve` / `incident:ai-close` / `incident:ai-assign` — **AI is advisory.** These
 *   are not merely ungranted; they must never exist, because a permission that exists can be
 *   granted by a tenant administrator who has not read this comment.
 */
export const REFUSED_INCIDENT_PERMISSIONS = [
  'incident:create',
  'incident:reopen',
  'incident:delete',
  'incident:admin',
  'incident:ai-resolve',
  'incident:ai-close',
  'incident:ai-assign',
] as const;

export const ROLES = Object.keys(ROLE_PERMISSIONS) as Role[];

export function isRole(value: string): value is Role {
  return value in ROLE_PERMISSIONS;
}
