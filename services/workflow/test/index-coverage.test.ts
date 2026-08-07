/**
 * Incident index coverage — **the test TD-22 existed for** (P-5.0 entry criterion G-4).
 *
 * The Workflow context shipped in P1-8 with three indexes and no coverage test, and P-5's search was
 * about to be layered on top of them. The tenant and camera services grew this model in P-3 after
 * review missed three such gaps by eye; this port strengthens it in one place that matters here.
 *
 * ### The classification, and why it is three-valued rather than two
 *
 * The camera model asks a yes/no question: is there an index that serves this query? With one filter
 * key that is the right question. Incident search has nine, and asking it of nine keys forces a
 * choice between indexing 36 pairs — write amplification for reads nobody has issued — or declaring
 * a real query uncovered and shipping anyway.
 *
 * Neither is honest, because the two failure modes are not the same size:
 *
 * - **The sort is not served** → MongoDB gathers every match and sorts in memory, against a 32 MB
 *   ceiling. This is a cliff. A year of incidents falls off it; a fixture never does.
 * - **An extra equality is not in the index** → the index still locates a bounded set and the extra
 *   predicate is applied as a residual filter. This costs documents examined. It grows linearly and
 *   shows up in `explain()` long before it hurts.
 *
 * So the model returns `covered` (every equality consumed, sort served), `bounded` (the index
 * narrows **past the tenant**, sort served, remainder residual) or `scan`.
 *
 * ⚠️ The "past the tenant" qualifier is load-bearing, and writing it the obvious way got it wrong
 * first. `tenant_raisedAt_id` consumes `tenantId` and serves the sort for *any* query, so a filter
 * with no index of its own looked `bounded` — while actually walking every incident the tenant has
 * ever raised, newest-first, discarding almost all of them. That is TD-22 wearing a different hat.
 * An index therefore only counts as narrowing if it consumes a key **beyond** the tenant prefix.
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
import { IncidentQuery } from '@vip/contracts';
import { INCIDENT_CURSOR, INCIDENT_INDEXES, type IndexSpec } from '../src/adapters/indexes.js';

interface QueryShape {
  name: string;
  equality: string[];
  /** Range predicates other than the sort key (the cursor walk is not a range for this purpose). */
  range?: string[];
  /** The leading sort key. Absent for a single-document lookup. */
  sort?: string;
}

type Coverage = 'covered' | 'bounded' | 'scan';

/**
 * How the planner decides, transcribed: equality keys must occupy a contiguous prefix, a range
 * predicate before the sort key consumes one key, and the sort key must then be the next key.
 */
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
  // A fully-consumed unique index yields at most one document; anything left is free.
  if (index.unique && position === keys.length) return 'covered';
  // Nothing matched at all — this index is irrelevant to this query.
  if (consumed === 0) return 'scan';

  const ranges = new Set(query.range ?? []);
  while (position < keys.length && ranges.has(keys[position]!) && keys[position] !== query.sort) {
    ranges.delete(keys[position]!);
    position += 1;
  }

  if (query.sort && keys[position] !== query.sort) return 'scan';
  if (equality.size === 0) return 'covered';
  // Predicates remain. They are residual filters over whatever this index located — which is only
  // a narrowing if the index consumed something beyond `tenantId`.
  return consumed > 1 ? 'bounded' : 'scan';
}

/** The best any declared index can do for this query, and which index does it. */
function best(query: QueryShape): { coverage: Coverage; index?: IndexSpec } {
  let bounded: IndexSpec | undefined;
  for (const index of INCIDENT_INDEXES) {
    const coverage = classify(index, query);
    if (coverage === 'covered') return { coverage, index };
    if (coverage === 'bounded' && !bounded) bounded = index;
  }
  return bounded ? { coverage: 'bounded', index: bounded } : { coverage: 'scan' };
}

/** The cursor walk on `(raisedAt, id)` that every paged read performs. */
const PAGED = { range: ['raisedAt'], sort: 'raisedAt' } as const;

/** Every read the incident store issues, transcribed from `mongo-incident-store.ts`. */
const QUERIES: QueryShape[] = [
  { name: 'get — by id', equality: ['tenantId', 'id'] },
  { name: 'getByDedupKey — idempotent promotion', equality: ['tenantId', 'source.dedupKey'] },
  { name: 'replace — version-guarded write', equality: ['tenantId', 'id'] },
  { name: 'list() — unfiltered, newest first', equality: ['tenantId'], ...PAGED },
  { name: 'list({ status })', equality: ['tenantId', 'status'], ...PAGED },
  { name: 'list({ severity })', equality: ['tenantId', 'severity'], ...PAGED },
  { name: 'list({ category })', equality: ['tenantId', 'category'], ...PAGED },
  {
    name: 'list({ eventType }) — behaviour search',
    equality: ['tenantId', 'triggeredBy.eventType'],
    ...PAGED,
  },
  { name: 'list({ cameraId })', equality: ['tenantId', 'triggeredBy.cameraId'], ...PAGED },
  { name: 'list({ zoneId })', equality: ['tenantId', 'triggeredBy.zoneId'], ...PAGED },
  { name: 'list({ ruleId }) — rule impact', equality: ['tenantId', 'source.ruleId'], ...PAGED },
  {
    name: 'list({ correlationId }) — the spine',
    equality: ['tenantId', 'correlationId'],
    ...PAGED,
  },
  { name: 'list({ assignee }) — my queue', equality: ['tenantId', 'assignee'], ...PAGED },
  { name: 'list({ from, to }) — a time window', equality: ['tenantId'], ...PAGED },
  {
    name: 'list({ status, severity }) — two filters at once',
    equality: ['tenantId', 'status', 'severity'],
    ...PAGED,
  },
  {
    name: 'list({ cameraId, from, to }) — the workspace default',
    equality: ['tenantId', 'triggeredBy.cameraId'],
    ...PAGED,
  },
];

describe('every incidents query is served by a declared index (G-4 / TD-22)', () => {
  it.each(QUERIES)('$name — narrowed by an index, never a tenant-wide scan', (query) => {
    const { coverage } = best(query);
    expect(coverage, `"${query.name}" scans the tenant — see INDEX_POLICY`).not.toBe('scan');
  });

  it('names the index each query is expected to use — an executable plan document', () => {
    const plan = Object.fromEntries(QUERIES.map((q) => [q.name, best(q).index?.name]));
    expect(plan).toMatchObject({
      'get — by id': 'uniq_tenant_incident',
      'getByDedupKey — idempotent promotion': 'uniq_tenant_dedupkey',
      'list() — unfiltered, newest first': 'tenant_raisedAt_id',
      'list({ status })': 'tenant_status_time',
      'list({ severity })': 'tenant_severity_time',
      'list({ cameraId })': 'tenant_camera_time',
      'list({ zoneId })': 'tenant_zone_time',
      'list({ ruleId }) — rule impact': 'tenant_rule_time',
      'list({ correlationId }) — the spine': 'tenant_correlation_time',
      'list({ assignee }) — my queue': 'tenant_assignee_time',
      'list({ eventType }) — behaviour search': 'tenant_eventType_time',
    });
  });

  /**
   * The distinction the three-valued model exists to record. Both of these are acceptable; being
   * unable to tell them apart is not.
   */
  it('records which queries are only *bounded* — one index chosen, the rest residual', () => {
    const bounded = QUERIES.filter((q) => best(q).coverage === 'bounded').map((q) => q.name);
    expect(bounded).toEqual(['list({ status, severity }) — two filters at once']);
  });
});

/**
 * The model checking itself. A coverage test that cannot fail proves nothing — the P-4.1 rule about
 * disabling the guard and watching the test go red, kept permanent instead of performed once.
 */
describe('the coverage model detects what it claims to detect', () => {
  it('calls a filter with no index of its own a `scan`, not merely uncovered', () => {
    const invented: QueryShape = {
      name: 'list({ title }) — a filter nobody indexed',
      equality: ['tenantId', 'title'],
      ...PAGED,
    };
    expect(best(invented).coverage).toBe('scan');
  });

  it('calls an index that stops at the filter key a `scan` — the TD-22 defect itself', () => {
    const truncated: IndexSpec = {
      name: 'tenant_camera',
      keys: ['tenantId', 'triggeredBy.cameraId'],
      serves: 'the index as it would have been written without INDEX_POLICY',
    };
    const query: QueryShape = {
      name: 'list({ cameraId })',
      equality: ['tenantId', 'triggeredBy.cameraId'],
      ...PAGED,
    };
    expect(classify(truncated, query)).toBe('scan');
    // …and the real one, which carries the cursor pair, does serve it.
    expect(best(query).coverage).toBe('covered');
  });
});

describe('the incident index set (G-4)', () => {
  it('leads every created index with tenantId — no cross-tenant scan is possible', () => {
    for (const index of INCIDENT_INDEXES.filter((i) => !i.implicit)) {
      expect(index.keys[0], `${index.name} must lead with tenantId`).toBe('tenantId');
    }
  });

  /**
   * The exact regression TD-22 named: `{tenantId, raisedAt, id}` serves an unfiltered list and
   * abandons the sort the moment a filter is added, so every filtered index must carry the cursor
   * pair after its filter key.
   */
  it('ends every non-unique index with the (raisedAt, id) cursor pair', () => {
    for (const index of INCIDENT_INDEXES.filter((i) => !i.unique && !i.implicit)) {
      expect(index.keys.slice(-2), `${index.name} must end in (raisedAt, id)`).toEqual([
        ...INCIDENT_CURSOR,
      ]);
    }
  });

  it('declares the cursor pair descending wherever it appears, matching the sort', () => {
    for (const index of INCIDENT_INDEXES.filter((i) => i.keys.includes('raisedAt'))) {
      expect(index.descending, `${index.name} must sort the cursor descending`).toEqual([
        ...INCIDENT_CURSOR,
      ]);
    }
  });

  it('declares no duplicate names and no duplicate key sets', () => {
    expect(new Set(INCIDENT_INDEXES.map((i) => i.name)).size).toBe(INCIDENT_INDEXES.length);
    expect(new Set(INCIDENT_INDEXES.map((i) => i.keys.join(','))).size).toBe(
      INCIDENT_INDEXES.length,
    );
  });

  /**
   * The guard that makes this test do its job. `IncidentQuery` is frozen as the P-5 search surface;
   * a tenth filter added without a tenth index is the exact defect TD-22 recorded, so the filter
   * list is asserted here and a new one fails until its index and its row above exist.
   */
  it('has one declared index per frozen IncidentQuery filter', () => {
    /*
     * ⚠️ `includeAnalyses` is excluded because it is a **mode**, not a filter: it selects
     * `{$exists:false}` on `analysisSessionId`, which `tenant_analysis_time` already leads with. An
     * index of its own would serve no query.
     */
    const filters = Object.keys(IncidentQuery.shape).filter(
      (key) =>
        key !== 'limit' &&
        key !== 'cursor' &&
        key !== 'from' &&
        key !== 'to' &&
        key !== 'includeAnalyses',
    );
    expect(filters.sort()).toEqual([
      'analysisSessionId',
      'assignee',
      'cameraId',
      'category',
      'correlationId',
      'eventType',
      'ruleId',
      'severity',
      'status',
      'zoneId',
    ]);
    // …and the time window rides the cursor index, which is why from/to are excluded above.
    expect(INCIDENT_INDEXES.filter((i) => !i.unique && !i.implicit)).toHaveLength(
      filters.length + 1,
    );
  });
});
