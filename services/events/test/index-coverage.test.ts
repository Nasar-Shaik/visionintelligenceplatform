/**
 * Event index coverage (P-5.0 entry criterion G-5, Architect rec 6).
 *
 * The same three-valued model the Workflow context uses, for the same reason: `covered` (every
 * equality consumed, sort served), `bounded` (the index narrows **past the tenant**, sort served,
 * remainder residual), `scan`. Nothing may be a `scan`.
 *
 * Two findings this test made visible rather than confirmed:
 *
 * 1. `GET /events/:id` had **no index at all** before this slice. A by-id fetch — the first thing
 *    the investigation workspace does — was a collection scan.
 * 2. `zoneId` had been a `GET /events` filter since P1-5 with no index behind it, and the three
 *    time indexes stopped at `occurredAt`, abandoning the `(occurredAt, id)` sort every paged read
 *    performs. Neither is new to P-5.0; both are fixed here because P-5 is about to lean on them.
 */
import { describe, expect, it } from 'vitest';
/*
 * ⚠️ Imported statically, at module load, NOT with `await import()` inside the test body.
 *
 * It was dynamic, and it made this test flaky in a way that looked like a logic failure: the first
 * cold import of the contracts barrel takes longer than vitest's 5 s default when the whole
 * monorepo's suites run in parallel on a cold cache, so the test **timed out** and the gate reported
 * a red that had nothing to do with indexes. Found while running the P-8 Phase 7 gate; the flake
 * predates that milestone and reproduces on the P-8 Phase 6 freeze commit.
 *
 * A module-level import is paid once during collection, where no timeout applies.
 */
import { EventQuery } from '@vip/contracts';
import { EVENT_CURSOR, EVENT_INDEXES, type IndexSpec } from '../src/adapters/indexes.js';

interface QueryShape {
  name: string;
  equality: string[];
  range?: string[];
  sort?: string;
}

type Coverage = 'covered' | 'bounded' | 'scan';

function classify(index: IndexSpec, query: QueryShape): Coverage {
  const keys = index.keys;
  const equality = new Set(query.equality);

  let position = 0;
  let consumed = 0;
  while (position < keys.length && equality.has(keys[position]!)) {
    equality.delete(keys[position]!);
    position += 1;
    consumed += 1;
  }
  if (index.unique && position === keys.length) return 'covered';
  if (consumed === 0) return 'scan';

  const ranges = new Set(query.range ?? []);
  while (position < keys.length && ranges.has(keys[position]!) && keys[position] !== query.sort) {
    ranges.delete(keys[position]!);
    position += 1;
  }

  if (query.sort && keys[position] !== query.sort) return 'scan';
  if (equality.size === 0) return 'covered';
  return consumed > 1 ? 'bounded' : 'scan';
}

function best(query: QueryShape): { coverage: Coverage; index?: IndexSpec } {
  let bounded: IndexSpec | undefined;
  for (const index of EVENT_INDEXES) {
    const coverage = classify(index, query);
    if (coverage === 'covered') return { coverage, index };
    if (coverage === 'bounded' && !bounded) bounded = index;
  }
  return bounded ? { coverage: 'bounded', index: bounded } : { coverage: 'scan' };
}

const PAGED = { range: ['occurredAt'], sort: 'occurredAt' } as const;

/** Every read the event store issues, transcribed from `mongo-event-store.ts`. */
const QUERIES: QueryShape[] = [
  { name: 'persist — dedup collapse', equality: ['tenantId', 'dedupKey'] },
  { name: 'getById — GET /events/:id', equality: ['tenantId', 'id'] },
  { name: 'query() — unfiltered, newest first', equality: ['tenantId'], ...PAGED },
  { name: 'query({ type })', equality: ['tenantId', 'type'], ...PAGED },
  { name: 'query({ cameraId })', equality: ['tenantId', 'cameraId'], ...PAGED },
  { name: 'query({ zoneId })', equality: ['tenantId', 'zoneId'], ...PAGED },
  {
    name: 'query({ correlationId }) — the spine',
    equality: ['tenantId', 'correlationId'],
    ...PAGED,
  },
  { name: 'query({ from, to })', equality: ['tenantId'], ...PAGED },
  { name: 'range() — replay window, oldest first', equality: ['tenantId'], ...PAGED },
  {
    name: 'range({ type }) — a filtered replay window',
    equality: ['tenantId', 'type'],
    ...PAGED,
  },
];

describe('every events query is served by a declared index (G-5)', () => {
  it.each(QUERIES)('$name — narrowed by an index, never a tenant-wide scan', (query) => {
    expect(best(query).coverage, `"${query.name}" scans the tenant`).not.toBe('scan');
  });

  it('names the index each query is expected to use — an executable plan document', () => {
    expect(Object.fromEntries(QUERIES.map((q) => [q.name, best(q).index?.name]))).toMatchObject({
      'persist — dedup collapse': 'uniq_tenant_dedup',
      'getById — GET /events/:id': 'tenant_event_id',
      'query() — unfiltered, newest first': 'tenant_occurredAt',
      'query({ type })': 'tenant_type_time',
      'query({ cameraId })': 'tenant_camera_time',
      'query({ zoneId })': 'tenant_zone_time',
      'query({ correlationId }) — the spine': 'tenant_correlation_time',
    });
  });
});

describe('the events index set (G-5)', () => {
  it('leads every created index with tenantId — no cross-tenant scan is possible', () => {
    for (const index of EVENT_INDEXES.filter((i) => !i.implicit)) {
      expect(index.keys[0], `${index.name} must lead with tenantId`).toBe('tenantId');
    }
  });

  it('ends every time-ordered index with the (occurredAt, id) cursor pair', () => {
    for (const index of EVENT_INDEXES.filter((i) => i.keys.includes('occurredAt'))) {
      expect(index.keys.slice(-2), `${index.name} must end in (occurredAt, id)`).toEqual([
        ...EVENT_CURSOR,
      ]);
    }
  });

  /**
   * Uniqueness is `dedupKey`'s job and must stay there. A unique `{tenantId, id}` would route a
   * genuine id collision into `persist`'s duplicate-key branch, which reports "already stored" and
   * skips publishing — silently dropping a real event to enforce a constraint nothing needed.
   */
  it('keeps the by-id index non-unique, so ingest semantics are unchanged', () => {
    const byId = EVENT_INDEXES.find((i) => i.name === 'tenant_event_id');
    expect(byId?.unique).toBeUndefined();
    expect(EVENT_INDEXES.filter((i) => i.unique && !i.implicit).map((i) => i.name)).toEqual([
      'uniq_tenant_dedup',
    ]);
  });

  it('has one declared index per EventQuery filter', () => {
    const filters = Object.keys(EventQuery.shape).filter(
      (key) => !['limit', 'cursor', 'from', 'to'].includes(key),
    );
    expect(filters.sort()).toEqual(['cameraId', 'correlationId', 'type', 'zoneId']);
  });

  it('declares no duplicate names and no duplicate key sets', () => {
    expect(new Set(EVENT_INDEXES.map((i) => i.name)).size).toBe(EVENT_INDEXES.length);
    expect(new Set(EVENT_INDEXES.map((i) => i.keys.join(','))).size).toBe(EVENT_INDEXES.length);
  });
});
