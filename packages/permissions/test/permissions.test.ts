import { describe, expect, it } from 'vitest';
import { can } from '../src/can.js';
import {
  INCIDENT_PERMISSIONS,
  REFUSED_INCIDENT_PERMISSIONS,
  ROLE_PERMISSIONS,
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
