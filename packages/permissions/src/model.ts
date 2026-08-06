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
    // P-5.2.0 — saved investigations, background jobs, and the access audit.
    'investigation:*',
    'job:*',
    /*
     * ⚠️ A tenant administrator may inspect the access audit; nobody below them may. See
     * `WORKSPACE_PERMISSIONS` for why the action is `inspect` and not `read`.
     */
    'audit:inspect',
    /*
     * ⚠️ P-5.4 — per-operator workload is staff monitoring. The action is `workload`, not `read`,
     * for exactly the reason `audit:inspect` is not `audit:read`: `*:read` would hand it to every
     * viewer (TD-26, §69). Aggregate metrics need no such grant.
     */
    'metrics:workload',
    /*
     * ⚠️ P-6.4 — system health. `system:read` was the obvious name and would have been **wrong in
     * both directions at once**: `*:read` would have handed the platform's internal component and
     * dependency topology to every `viewer`, while `admin` — which holds no `*:read` — would have
     * been **refused a page its own operators could see**. Measured, not reasoned: the route test
     * failed as `admin` before it failed as anything else.
     *
     * `inspect`, for the same reason `audit:inspect` is not `audit:read` (TD-26, §69).
     */
    'system:inspect',
    /*
     * ⚠️ P-8 Phase 4 — object tracking. Granted explicitly here for the reason the note above
     * records: `admin` holds no `*:read`, so a resource that only reaches operators and viewers
     * through the wildcard would leave the tenant's own administrator refused a page their staff
     * can see. That failure has happened once in this file already.
     *
     * `track:read` rather than folding it into `camera:read`, because a track is a record of a
     * PERSON moving rather than a property of a device — and a tenant that wants to withhold
     * movement analytics from a role must be able to, without also withholding the camera list.
     */
    'track:read',
    /*
     * ⚠️ P-8 Phase 6 — Camera Processing Assignment. `assignment:read` is listed explicitly for the
     * reason this file has now recorded three times: `admin` holds no `*:read`, so a new resource
     * that only reaches operators and viewers through the wildcard leaves the tenant's own
     * administrator refused a page their staff can see.
     *
     * `assignment:*` rather than folding it into `camera:*`: deciding which cameras consume AI
     * compute is a spending decision, and a tenant must be able to grant camera administration
     * without also granting it.
     */
    'assignment:*',
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
    // P-5.2.0 — saving and pinning your own investigative work is operator work.
    'investigation:write',
    /* Cancelling a runaway export you started. Reading jobs already arrives via `*:read`. */
    'job:cancel',
    /*
     * ⚠️ P-6.4 — the operator on shift is the person who has to decide whether the platform being
     * slow is worth phoning someone about. Withholding system health from them would leave that
     * decision to a role that is not in the room at 3am. A `viewer` does not get it: "MongoDB is
     * failing for Events" is not actionable by someone who only reads incidents, and it is the
     * deployment's internal topology.
     */
    'system:inspect',
    /*
     * ⚠️ P-8 Phase 6 — the operator on shift may **suspend** AI on a camera and resume it, and may
     * do neither of the two things that change what the deployment costs or how it is shaped.
     *
     * Pausing the analytics on a till while an engineer works under it is shift work, and routing it
     * through an administrator means it does not happen. Binding a camera to a profile, moving it
     * between runtimes, or enabling AI on a camera that had none are configuration decisions with a
     * compute bill attached — those stay with `admin` via `assignment:*`.
     */
    'assignment:control',
  ],
  /*
   * ⚠️ `*:read` includes `track:read`, and that is correct rather than an oversight: a viewer can
   * already watch the footage a track is derived from, so withholding the derived, anonymous path
   * while showing the video it came from would protect nothing.
   */
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

/**
 * The Investigation Workspace permission catalog (P-5.2.0), stated as data for the same reason
 * `INCIDENT_PERMISSIONS` is.
 *
 * ### ⚠️ `audit:inspect`, and the wildcard that nearly granted it to everyone
 *
 * The obvious name for reading the access audit is `audit:read`. Writing it that way **grants it to
 * every operator and every viewer**, because both roles hold `*:read` — so introducing the
 * permission would have silently handed a log of *who looked at what, when, from which IP* to the
 * least privileged role in the product. Nothing would have failed; the grant is a wildcard
 * expansion, and no test asserted the negative.
 *
 * The action is therefore `inspect`. That is not a euphemism — inspecting a log of colleagues'
 * activity is a genuinely different act from reading a camera or an incident, and it deserves a
 * verb that does not ride a wildcard. `permissions.test.ts` asserts operator and viewer do **not**
 * hold it, so a future rename back to `audit:read` fails loudly instead of quietly widening access.
 *
 * ⚠️ **The general hazard is recorded, not just this instance:** `*:read` means every future
 * `<resource>:read` permission is granted to viewers the moment it is named. Any new read
 * permission over sensitive data must either be named off the wildcard, or the wildcard must be
 * narrowed — which is a breaking change and needs an ADR. Recorded as TD-26.
 */
export const WORKSPACE_PERMISSIONS = [
  /** Saved searches, saved investigations, pins. Read arrives via `*:read` for operator/viewer. */
  'investigation:read',
  'investigation:write',
  /** Background jobs: listing them, and cancelling one you started. */
  'job:read',
  'job:cancel',
  /** ⚠️ The access audit. See the note above — deliberately not `audit:read`. */
  'audit:inspect',
  /**
   * Aggregate investigation metrics. ⚠️ Names **no person** — that is what makes it safe to reach
   * every operator and viewer through `*:read`.
   */
  'metrics:read',
  /**
   * ⚠️ **Per-operator workload — staff monitoring.** Granted to `admin` and above only.
   *
   * The action is deliberately `workload` rather than `read`. This platform has already had one
   * finding of this exact class: `audit:read` would have exposed a staff-activity log to every
   * `viewer`, because both `operator` and `viewer` hold `*:read` (TD-26, CONSTRAINTS §69). A
   * productivity measure of named employees is the same hazard with a friendlier name, so it gets
   * the same treatment — an action no wildcard in `ROLE_PERMISSIONS` matches.
   */
  'metrics:workload',
] as const;

/**
 * ⚠️ **Permissions deliberately NOT created for the workspace.**
 *
 * - `search:query` — search is a **federation** over per-entity query surfaces, each already
 *   guarded by its own permission (`incident:read`, `camera:read`, …). A separate search permission
 *   would be a second gate that can disagree with the first, and the disagreement resolves in
 *   whichever direction the code happens to check — so a principal could search a resource they
 *   cannot open, or fail to search one they can. Instead, an entity the principal may not read
 *   comes back as a `forbidden` gap in the response.
 * - `report:generate` — an incident report is an incident export. `incident:export` already
 *   authorises it, and a second spelling of the same authority is a second thing to keep in sync
 *   (the reasoning that refused `incident:admin` in P-5.1).
 * - `playback:read` — playback resolves recordings and evidence, each already permissioned. The
 *   panel rides `stream:read`.
 * - `audit:delete` / `audit:write` — the access audit is **append-only**. The absence of these is
 *   the guarantee, exactly as the absent `DELETE` route is for archived locations (§38).
 */
export const REFUSED_WORKSPACE_PERMISSIONS = [
  'search:query',
  'report:generate',
  'playback:read',
  'audit:write',
  'audit:delete',
] as const;

/**
 * The Camera Processing Assignment catalog (P-8 Phase 6), stated as data like the two above.
 *
 * ### ⚠️ `assignment:read` rides `*:read`, and that is the correct answer here
 *
 * TD-26's hazard is that every new `<resource>:read` is handed to `viewer` the moment it is named.
 * The question is always whether that is wrong, not whether it happens. Here it is right: which
 * cameras are being analysed, on which runtime, is **device configuration**, not a record of a
 * person — a viewer can already watch the footage. Withholding "is AI on for this camera" from
 * someone who can watch the camera would protect nothing and would leave the console's assignment
 * page blank for most of its users.
 *
 * `assignment:control` and `assignment:write` are the ones that do not ride a wildcard, and the split
 * between them is the point: suspending analytics is shift work, deciding what the deployment
 * analyses is not.
 */
export const ASSIGNMENT_PERMISSIONS = [
  /** The assignment, runtime, profile, capacity and history views. */
  'assignment:read',
  /** Pause and resume an existing assignment. Granted to `operator`. */
  'assignment:control',
  /** Enable/disable AI, bind profiles, move runtimes, bulk operations, groups. `admin` and above. */
  'assignment:write',
  /** Register, update and remove AI runtimes — deployment infrastructure. `admin` and above. */
  'assignment:runtime',
] as const;

/**
 * ⚠️ **Permissions deliberately NOT created for assignment.**
 *
 * - `assignment:balance` — there is no auto-balancer, by explicit architectural decision. A
 *   permission that exists can be granted, and granting authority over a mechanism that does not
 *   exist is how a future scheduler arrives already authorised and unreviewed.
 * - `assignment:license` — licensing is an extension point with no implementation. The limits are
 *   read from configuration and enforced by the same code path for everyone; there is nothing a
 *   tenant principal could be permitted to do to them.
 * - `runtime:read` — a second spelling of `assignment:read` over the same documents. Two gates on
 *   one resource disagree eventually, and the disagreement resolves in whichever direction the code
 *   happens to check (the reasoning that refused `incident:admin` and `search:query`).
 */
export const REFUSED_ASSIGNMENT_PERMISSIONS = [
  'assignment:balance',
  'assignment:license',
  'runtime:read',
] as const;

export const ROLES = Object.keys(ROLE_PERMISSIONS) as Role[];

export function isRole(value: string): value is Role {
  return value in ROLE_PERMISSIONS;
}
