/**
 * P-5.2.0 — unified search freeze (Architect rec 6).
 *
 * The load-bearing test here is the last one in the first block: **no entity may claim to be
 * searchable without an indexed way to match**. That is entry criterion G-4 — "never expose a query
 * without index validation" — reduced to something that fails in CI.
 */
import { describe, expect, it } from 'vitest';
import {
  REFUSED_SEARCH_ENTITIES,
  SEARCH_ENTITIES,
  SEARCH_MAX_ENTITIES,
  SEARCH_MAX_RESULTS_PER_ENTITY,
  SearchEntityCapability,
  SearchEntityKind,
  SearchQuery,
  SearchResponse,
} from '../src/search/search.js';

describe('SEARCH_ENTITIES — the capability register', () => {
  it('covers every entity kind exactly once', () => {
    const entities = SEARCH_ENTITIES.map((e) => e.entity).sort();
    expect(entities).toEqual([...SearchEntityKind.options].sort());
  });

  it('every row parses', () => {
    for (const capability of SEARCH_ENTITIES) {
      expect(() => SearchEntityCapability.parse(capability)).not.toThrow();
    }
  });

  /*
   * ⚠️ G-4, mechanised. A supported entity must match text through an index, or declare that it
   * does not do text matching at all. `none` on a supported entity would be a scan.
   */
  it('⚠️ no supported entity matches text without an index', () => {
    for (const capability of SEARCH_ENTITIES) {
      if (!capability.supported) continue;
      expect(capability.match).not.toBe('none');
      if (capability.match === 'filter-only') {
        /* Filter-only is honest — but it must say why there is no keyword search. */
        expect(capability.limitation).toBeTruthy();
      }
    }
  });

  it('every unsupported entity states why', () => {
    for (const capability of SEARCH_ENTITIES) {
      if (!capability.supported) expect(capability.limitation).toBeTruthy();
    }
  });

  /*
   * Decision 4: Site/Building/Floor/Zone are the `type` of a location, and `actor` is a reference
   * rather than a record. Copying the Location Hierarchy's frozen type enum in here would leave two
   * enums to keep in sync forever.
   */
  it('⚠️ refuses the entities that are not entities', () => {
    for (const refused of REFUSED_SEARCH_ENTITIES) {
      expect(SearchEntityKind.options as readonly string[]).not.toContain(refused);
    }
    expect(SearchEntityKind.options).toContain('location');
  });

  it('leaves operator search unsupported — directory disclosure needs its own permission', () => {
    const operator = SEARCH_ENTITIES.find((e) => e.entity === 'operator');
    expect(operator?.supported).toBe(false);
    expect(operator?.limitation).toContain('permission');
  });

  it('every supported entity declares the filters it accepts', () => {
    for (const capability of SEARCH_ENTITIES) {
      if (capability.supported && capability.match === 'filter-only') {
        expect(capability.filters.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('SearchQuery — the fan-out budget', () => {
  it('caps the number of entities one search may touch', () => {
    expect(
      SearchQuery.safeParse({
        entities: [...SearchEntityKind.options].slice(0, SEARCH_MAX_ENTITIES + 1),
      }).success,
    ).toBe(false);
  });

  it('caps results per entity', () => {
    expect(
      SearchQuery.safeParse({ limitPerEntity: SEARCH_MAX_RESULTS_PER_ENTITY + 1 }).success,
    ).toBe(false);
    expect(SearchQuery.parse({}).limitPerEntity).toBe(SEARCH_MAX_RESULTS_PER_ENTITY);
  });
});

describe('SearchResponse — gaps are not error handling', () => {
  const response = {
    tenantId: 'tnt_a',
    query: { limitPerEntity: 20 },
    tookMs: 12,
    derivedAt: '2026-08-03T00:00:00.000Z',
  };

  it('defaults every collection, so an empty response is still well-formed', () => {
    const parsed = SearchResponse.parse(response);
    expect(parsed.groups).toEqual([]);
    expect(parsed.gaps).toEqual([]);
    expect(parsed.consulted).toEqual([]);
  });

  /*
   * ⚠️ Decision 2. Ranking incidents against cameras needs one scorer over one index; a blended
   * number across federated contexts is arithmetic on incomparable quantities. A group states the
   * ordering it used, and `relevance` is only ever *within* a group.
   */
  it('orders per group, and there is no global score field', () => {
    const parsed = SearchResponse.parse({
      ...response,
      groups: [
        {
          entity: 'incident',
          ordering: 'recency',
          match: 'filter-only',
          items: [{ entity: 'incident', id: 'inc_1', title: 'Loitering' }],
        },
      ],
    });
    expect(parsed.groups[0]?.ordering).toBe('recency');
    expect(parsed.groups[0]?.items[0]).not.toHaveProperty('score');
    expect(parsed).not.toHaveProperty('relevance');
  });

  /* "No results" and "we could not look" are different answers. */
  it('distinguishes unsupported, unavailable and not-requested', () => {
    const parsed = SearchResponse.parse({
      ...response,
      gaps: [
        { entity: 'operator', reason: 'unsupported', detail: 'no indexed principal search' },
        { entity: 'camera', reason: 'unavailable', detail: 'timed out after 2000ms' },
        { entity: 'rule', reason: 'not-requested', detail: 'not in `entities`' },
      ],
    });
    expect(parsed.gaps.map((g) => g.reason)).toEqual([
      'unsupported',
      'unavailable',
      'not-requested',
    ]);
  });

  /* ⚠️ A total costs a second unbounded count query. Absent means "not counted", never zero. */
  it('leaves total absent rather than reporting a fabricated count', () => {
    const parsed = SearchResponse.parse({
      ...response,
      groups: [{ entity: 'incident', ordering: 'recency', match: 'filter-only', items: [] }],
    });
    expect(parsed.groups[0]?.total).toBeUndefined();
  });

  /* A result is a projection. Returning whole records would leak past the entity's own read gate. */
  it('returns a projection, not a record', () => {
    const parsed = SearchResponse.parse({
      ...response,
      groups: [
        {
          entity: 'incident',
          ordering: 'recency',
          match: 'filter-only',
          items: [{ entity: 'incident', id: 'inc_1', title: 'Loitering', status: 'raised' }],
        },
      ],
    });
    expect(parsed.groups[0]?.items[0]).not.toHaveProperty('status');
  });
});
