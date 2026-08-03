import { describe, expect, it } from 'vitest';
import { can } from '../src/can.js';
import {
  INCIDENT_PERMISSIONS,
  REFUSED_INCIDENT_PERMISSIONS,
  REFUSED_WORKSPACE_PERMISSIONS,
  ROLE_PERMISSIONS,
  WORKSPACE_PERMISSIONS,
} from '../src/model.js';

/**
 * The AI boundary, asserted rather than trusted (P-5.1, Architect rec 9).
 *
 * "AI may recommend, never mutate" is a claim about the permission catalog. If it is only a
 * convention, the first tenant administrator to grant a plausible-looking permission breaks it
 * silently. These tests make the catalog the enforcement point.
 */
describe('the incident permission catalog (P-5.1)', () => {
  it('grants no role a permission that would let an AI change incident state', () => {
    for (const refused of REFUSED_INCIDENT_PERMISSIONS) {
      expect(INCIDENT_PERMISSIONS as readonly string[]).not.toContain(refused);
    }
  });

  it('reserves incident:ai-recommend and grants it to nobody', () => {
    expect(INCIDENT_PERMISSIONS as readonly string[]).toContain('incident:ai-recommend');
    for (const [role, granted] of Object.entries(ROLE_PERMISSIONS)) {
      if (role === 'owner') continue; // `*` is the tenant owner, a human, by definition
      expect(granted, `${role} must not be granted ai-recommend directly`).not.toContain(
        'incident:ai-recommend',
      );
    }
  });

  /**
   * ⚠️ The one that matters. `admin` holds `incident:*`, which a wildcard matcher expands to every
   * incident permission — including `ai-recommend`. That is correct: a human admin may produce a
   * recommendation. What must never be true is a *write* permission whose name implies AI authority.
   */
  it('has no permission whose name pairs `ai` with a state-changing verb', () => {
    for (const permission of INCIDENT_PERMISSIONS) {
      const isAi = permission.includes('ai-');
      const mutates = /resolve|close|assign|delete|escalate|ack|investigate/.test(permission);
      expect(isAi && mutates, `${permission} would grant an AI write authority`).toBe(false);
    }
  });

  /**
   * ⚠️ Splitting `close` out of `resolve` is **additive**: operators keep the ability they have
   * today, and a tenant that wants separation of duties revokes this one grant. Withholding it here
   * would have been a breaking behaviour change wearing a new permission's clothes.
   */
  it('still grants operators close — the split is additive, not a silent removal', () => {
    expect(ROLE_PERMISSIONS.operator).toContain('incident:close');
    expect(ROLE_PERMISSIONS.admin).toContain('incident:*');
  });

  it('keeps the platform resource:action spelling — no dotted duplicates', () => {
    for (const permission of INCIDENT_PERMISSIONS) {
      expect(permission.startsWith('incident:')).toBe(true);
      expect(permission.split(':')).toHaveLength(2);
    }
  });
});

/**
 * The refusals, as behaviour rather than as a comment.
 *
 * A permission that does not exist cannot be granted — but a wildcard can still *match* a string
 * nobody defined. These assert that the refused names resolve the way the invariants require:
 * `incident:*` is a human admin grant and does match them, which is why the real guarantee is that
 * **no route consumes them**. The catalog test above keeps the names out; this records the nuance
 * honestly rather than claiming a protection the wildcard does not provide.
 */
describe('refused incident permissions (P-5.1)', () => {
  it('are absent from the catalog, which is what stops a route from requiring one', () => {
    const catalog = new Set<string>(INCIDENT_PERMISSIONS);
    for (const refused of REFUSED_INCIDENT_PERMISSIONS) {
      expect(catalog.has(refused), `${refused} must not be in the catalog`).toBe(false);
    }
  });

  /**
   * ⚠️ Recorded because it is the honest limit of the mechanism: `incident:*` is a wildcard, so it
   * would match a refused name if one ever existed. The protection is therefore that the name never
   * exists and no handler asks for it — not that the matcher would refuse it.
   */
  it('would be matched by the admin wildcard if they existed — hence they must not exist', () => {
    expect(can(['incident:*'], 'incident:delete')).toBe(true);
    expect(INCIDENT_PERMISSIONS as readonly string[]).not.toContain('incident:delete');
  });

  it('are not reachable through any non-admin role', () => {
    for (const role of ['operator', 'viewer'] as const) {
      for (const refused of REFUSED_INCIDENT_PERMISSIONS) {
        expect(can(ROLE_PERMISSIONS[role], refused), `${role} → ${refused}`).toBe(false);
      }
    }
  });
});

/**
 * The workspace permission catalog (P-5.2.0).
 *
 * ⚠️ The first test here is the one that matters. `audit:read` would have been the obvious name for
 * reading the access log — and both `operator` and `viewer` hold `*:read`, so naming it that way
 * would have granted a log of *who looked at what, when, from which IP* to the least privileged
 * role in the product. Nothing would have failed: it is a wildcard expansion, and no test asserted
 * the negative. These assert it.
 */
describe('the workspace permission catalog (P-5.2.0)', () => {
  it('⚠️ never grants the access audit to an operator or a viewer', () => {
    for (const role of ['operator', 'viewer'] as const) {
      expect(can(ROLE_PERMISSIONS[role], 'audit:inspect')).toBe(false);
    }
    expect(can(ROLE_PERMISSIONS.admin, 'audit:inspect')).toBe(true);
    expect(can(ROLE_PERMISSIONS.owner, 'audit:inspect')).toBe(true);
  });

  /*
   * The general hazard, pinned. If anyone renames the permission to `audit:read`, or adds any other
   * sensitive read permission, this fails — which is the point (TD-26).
   */
  it('⚠️ proves the wildcard would have granted it, had it been named audit:read', () => {
    expect(can(ROLE_PERMISSIONS.viewer, 'audit:read')).toBe(true);
    expect(WORKSPACE_PERMISSIONS as readonly string[]).not.toContain('audit:read');
    expect(WORKSPACE_PERMISSIONS as readonly string[]).toContain('audit:inspect');
  });

  it('creates no permission that duplicates an authority that already exists', () => {
    const all = [...INCIDENT_PERMISSIONS, ...WORKSPACE_PERMISSIONS] as readonly string[];
    for (const refused of REFUSED_WORKSPACE_PERMISSIONS) {
      expect(all).not.toContain(refused);
    }
    /* An incident report is an incident export — `incident:export` already authorises it. */
    expect(all).toContain('incident:export');
  });

  it('keeps the access audit append-only by refusing a write and a delete permission', () => {
    expect(REFUSED_WORKSPACE_PERMISSIONS as readonly string[]).toContain('audit:write');
    expect(REFUSED_WORKSPACE_PERMISSIONS as readonly string[]).toContain('audit:delete');
  });

  it('lets an operator save their own investigative work and cancel their own exports', () => {
    expect(can(ROLE_PERMISSIONS.operator, 'investigation:write')).toBe(true);
    expect(can(ROLE_PERMISSIONS.operator, 'job:cancel')).toBe(true);
    /* A viewer may read saved work (via `*:read`) but may not create it. */
    expect(can(ROLE_PERMISSIONS.viewer, 'investigation:write')).toBe(false);
  });
});

/**
 * P-5.4 — investigation metrics.
 *
 * ⚠️ The same finding as `audit:inspect`, one milestone later and in a friendlier costume: a
 * per-operator productivity measure is a staff-monitoring surface, and `*:read` would have handed
 * it to every viewer.
 */
describe('P-5.4 metrics permissions', () => {
  it('lets aggregate metrics reach everyone who can read — they name no person', () => {
    expect(can(ROLE_PERMISSIONS.viewer, 'metrics:read')).toBe(true);
    expect(can(ROLE_PERMISSIONS.operator, 'metrics:read')).toBe(true);
  });

  it('⚠️ keeps per-operator workload away from every wildcard below admin', () => {
    expect(can(ROLE_PERMISSIONS.viewer, 'metrics:workload')).toBe(false);
    expect(can(ROLE_PERMISSIONS.operator, 'metrics:workload')).toBe(false);
    expect(can(ROLE_PERMISSIONS.admin, 'metrics:workload')).toBe(true);
    expect(can(ROLE_PERMISSIONS.owner, 'metrics:workload')).toBe(true);
  });

  it('⚠️ proves the hazard: the read-spelling WOULD have been granted to every viewer', () => {
    /* Had it been named `metrics:workload-read`, or any `*:read`, this would have been true. */
    expect(can(ROLE_PERMISSIONS.viewer, 'metrics:read')).toBe(true);
    expect(WORKSPACE_PERMISSIONS as readonly string[]).toContain('metrics:workload');
    for (const permission of WORKSPACE_PERMISSIONS as readonly string[]) {
      if (!permission.startsWith('metrics:')) continue;
      if (permission === 'metrics:read') continue;
      /* Every other metrics permission must be unreachable by a viewer. */
      expect(can(ROLE_PERMISSIONS.viewer, permission)).toBe(false);
    }
  });
});
