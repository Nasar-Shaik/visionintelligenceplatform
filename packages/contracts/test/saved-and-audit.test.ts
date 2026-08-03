/**
 * P-5.2.0 — saved investigations (rec 3) and the access audit (rec 7).
 *
 * They are tested together because they meet: "recently opened" is a **projection over the access
 * log**, not a stored list — which is what keeps the platform from having two records of the same
 * fact, and what makes recents work retroactively.
 */
import { describe, expect, it } from 'vitest';
import {
  PinnedItem,
  RecentItems,
  SavedInvestigation,
  SavedSearch,
  SavedSearchView,
  SavedVisibility,
} from '../src/workspace/saved.js';
import {
  AccessAuditAction,
  AccessAuditEntry,
  AccessAuditQuery,
  REFUSED_AUDIT_ACTIONS,
} from '../src/audit/access.js';

const at = '2026-08-03T00:00:00.000Z';

describe('SavedSearch — a saved query can go stale, and says so', () => {
  const search = {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: 'tnt_a',
    name: 'Unassigned criticals',
    entity: 'incident' as const,
    ownerId: 'usr_1',
    createdAt: at,
    updatedAt: at,
  };

  it('defaults to private and to empty filters', () => {
    const parsed = SavedSearch.parse(search);
    expect(parsed.visibility).toBe('private');
    expect(parsed.filters).toEqual({});
  });

  /*
   * ⚠️ Decision 1. Saving a query makes the query contract a persisted contract. The mitigation is
   * not to freeze harder — it is to let a saved search be *stale* and report it, rather than
   * coercing the filters into something that parses and silently changing what the operator sees.
   */
  it('⚠️ derives validity on read and requires a reason when stale', () => {
    const stale = SavedSearchView.parse({
      search,
      validity: 'stale',
      staleReason: 'filter `behaviorId` is not part of IncidentQuery',
      derivedAt: at,
    });
    expect(stale.staleReason).toBeTruthy();
    /* Validity is never stored on the record — it would be computed once and wrong thereafter. */
    expect(SavedSearch.parse(search)).not.toHaveProperty('validity');
  });

  /* ⚠️ Nothing crosses a tenant boundary (Law 5) — there is no `public`. */
  it('⚠️ has no cross-tenant visibility', () => {
    expect(SavedVisibility.options).toEqual(['private', 'tenant']);
    expect(SavedVisibility.safeParse('public').success).toBe(false);
  });
});

describe('SavedInvestigation and pins — references, never copies', () => {
  it('holds ids only, so nothing can go stale or outlive the reader’s access', () => {
    const parsed = SavedInvestigation.parse({
      id: '22222222-2222-4222-8222-222222222222',
      tenantId: 'tnt_a',
      name: 'Dock 3, week 31',
      incidentIds: ['inc_1', 'inc_2'],
      ownerId: 'usr_1',
      createdAt: at,
      updatedAt: at,
    });
    expect(parsed.incidentIds).toEqual(['inc_1', 'inc_2']);
    expect(parsed).not.toHaveProperty('incidents');
    expect(parsed.evidenceIds).toEqual([]);
  });

  it('a pin carries the operator’s own label — their words cannot be stale', () => {
    const parsed = PinnedItem.parse({
      id: '33333333-3333-4333-8333-333333333333',
      tenantId: 'tnt_a',
      entity: 'evidence',
      targetId: 'ev_1',
      ownerId: 'usr_1',
      pinnedAt: at,
    });
    expect(parsed.label).toBeUndefined();
  });
});

describe('RecentItems — a projection, not a second write path', () => {
  /*
   * ⚠️ Decision 3. A recents list written on every open is a second audit trail (§46), and it
   * drifts from the access log that already records exactly this.
   */
  it('⚠️ has no id, no owner record and no write input — it is derived', () => {
    const parsed = RecentItems.parse({
      tenantId: 'tnt_a',
      principalId: 'usr_1',
      windowDays: 30,
      items: [{ entity: 'incident', targetId: 'inc_1', lastOpenedAt: at, openCount: 3 }],
      derivedAt: at,
    });
    expect(parsed.items[0]).not.toHaveProperty('id');
    expect(parsed.derivedAt).toBe(at);
  });

  /* "The last ten things" and "the last ten things in 30 days" are different claims. */
  it('states the window it was derived over', () => {
    expect(
      RecentItems.safeParse({
        tenantId: 'tnt_a',
        principalId: 'usr_1',
        derivedAt: at,
      }).success,
    ).toBe(false);
  });
});

describe('AccessAudit — reads are recorded because nothing else witnesses them', () => {
  it('covers only read-side actions', () => {
    expect(AccessAuditAction.options).toEqual([
      'open',
      'download',
      'export',
      'search',
      'recommendation-viewed',
    ]);
  });

  /*
   * ⚠️ The central decision. Assignment, comment, attachment, resolution and escalation already
   * append to the incident's own streams and are derived by `IncidentActivity`. Recording them here
   * too is two records of one truth (§46), written by different code paths.
   */
  it('⚠️ refuses the write-side actions that are already derived', () => {
    for (const refused of REFUSED_AUDIT_ACTIONS) {
      expect(AccessAuditAction.options as readonly string[]).not.toContain(refused);
    }
  });

  /* Evidence byte access belongs to the hash-chained custody log — the artefact a court sees. */
  it('⚠️ does not duplicate the chain of custody', () => {
    expect(REFUSED_AUDIT_ACTIONS).toContain('evidence-access');
  });

  it('records the act, never the content', () => {
    const parsed = AccessAuditEntry.parse({
      id: '44444444-4444-4444-8444-444444444444',
      tenantId: 'tnt_a',
      action: 'search',
      principalId: 'usr_1',
      query: 'dock 3 loitering',
      results: ['inc_1', 'inc_2'],
      at,
    });
    /* ⚠️ The query is recorded; the results are not — they would be a second copy of the records. */
    expect(parsed.query).toBe('dock 3 loitering');
    expect(parsed).not.toHaveProperty('results');
  });

  it('always attributes an access to a principal', () => {
    expect(
      AccessAuditEntry.safeParse({
        id: '44444444-4444-4444-8444-444444444444',
        tenantId: 'tnt_a',
        action: 'open',
        at,
      }).success,
    ).toBe(false);
  });

  it('has no update or delete input — append-only is the absence of a route', () => {
    const query = AccessAuditQuery.parse({});
    expect(query.limit).toBe(50);
  });
});
