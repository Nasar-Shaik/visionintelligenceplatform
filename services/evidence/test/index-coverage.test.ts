/**
 * Evidence index coverage — **the test TD-25 existed for** (P-5.1, Architect-approved F-1).
 *
 * ### ⚠️ This model is stronger than the one it was ported from, because measuring found it wrong
 *
 * The Workflow/camera/tenant model asks whether the index serves the **leading** sort key. Ported
 * here verbatim, it declared the pre-P-5.1 `tenant_incident`
 * (`{tenantId, source.incidentId, capturedAt}`) **`covered`** — while `explain()` against a real
 * MongoDB showed that exact index producing a **blocking `SORT` stage**. Two corrections came out
 * of that, and both matter for every future port:
 *
 * **1. The sort is a *pair*, not a key.** Every bounded read here sorts by `(capturedAt, _id)`.
 * An index that reaches `capturedAt` and stops still hands the tiebreak to an in-memory sort. The
 * model now walks the **whole** sort key list.
 *
 * **2. "Unindexed" is not one failure — it depends on the filter's cardinality.** The measurements:
 *
 * | Filter          | Cardinality | Index (before)    | Examined / returned |
 * | --------------- | ----------- | ----------------- | ------------------- |
 * | `eventId`       | identity    | none              | **500 / 1**         |
 * | `correlationId` | identity    | none              | **399 / 50**        |
 * | `cameraId`      | identity    | none              | **497 / 50**        |
 * | `kind`+`status` | enum        | none (fell back)  | 99 / 50             |
 *
 * A residual predicate over a **cursor-ordered walk with a limit** costs roughly
 * `limit ÷ selectivity` documents examined — 100 for a 50%-selective enum, and the entire tenant
 * history for a near-unique id. So an **identity** filter must have a narrowing index; a
 * low-cardinality **enum** filter may legitimately ride the time index, and indexing it buys almost
 * nothing. The model asserts exactly that distinction rather than pretending both are the same
 * defect.
 */
import { describe, expect, it } from 'vitest';
import { EVIDENCE_CURSOR, EVIDENCE_INDEXES, type IndexSpec } from '../src/adapters/indexes.js';

/**
 * How selective a filter is, which decides whether it *needs* an index.
 *
 * - `identity` — an id. Near-unique, so an unindexed one examines the tenant's whole history.
 * - `enum` — a handful of values. Rides the cursor walk; an index on it saves little and costs a write.
 */
type Cardinality = 'identity' | 'enum';

interface QueryShape {
  name: string;
  /** Equality predicates, each with the cardinality that decides whether it must be indexed. */
  equality: [key: string, cardinality: Cardinality][];
  range?: string[];
  /** The full compound sort, in order. Absent for a single-document lookup. */
  sort?: readonly string[];
}

type Coverage = 'covered' | 'bounded' | 'scan';

/**
 * How the planner decides, transcribed: equality keys must occupy a contiguous prefix, a range
 * before the sort consumes one key, and **every** sort key must then follow in order.
 */
function classify(index: IndexSpec, query: QueryShape): Coverage {
  const keys = index.keys;
  const equality = new Map(query.equality);

  let position = 0;
  let consumed = 0;
  while (position < keys.length && equality.has(keys[position]!)) {
    equality.delete(keys[position]!);
    position += 1;
    consumed += 1;
  }
  if (index.unique && position === keys.length) return 'covered';
  if (consumed === 0) return 'scan';

  const sort = query.sort ?? [];
  const ranges = new Set(query.range ?? []);
  while (position < keys.length && ranges.has(keys[position]!) && !sort.includes(keys[position]!)) {
    ranges.delete(keys[position]!);
    position += 1;
  }

  // ⚠️ Every sort key, in order — not just the first. This is correction 1.
  for (const key of sort) {
    if (keys[position] !== key) return 'scan';
    position += 1;
  }

  if (equality.size === 0) return 'covered';
  /*
   * Predicates remain, applied residually over the cursor-ordered walk this index provides. Whether
   * that is acceptable depends **only** on what is left over, not on how much the index consumed —
   * correction 2, and it subsumes the Workflow model's "must consume past the tenant" rule with a
   * sharper one. A leftover identity filter examines the tenant's whole history to find its handful
   * of matches (measured: 500 examined, 1 returned). A leftover enum costs `limit ÷ selectivity`
   * (measured: 99 examined, 50 returned), which the limit bounds.
   */
  return [...equality.values()].includes('identity') ? 'scan' : 'bounded';
}

function best(query: QueryShape): { coverage: Coverage; index?: IndexSpec } {
  let bounded: IndexSpec | undefined;
  for (const index of EVIDENCE_INDEXES) {
    const coverage = classify(index, query);
    if (coverage === 'covered') return { coverage, index };
    if (coverage === 'bounded' && !bounded) bounded = index;
  }
  return bounded ? { coverage: 'bounded', index: bounded } : { coverage: 'scan' };
}

/** The cursor walk on `(capturedAt, _id)` that every paged read performs. */
const PAGED = { range: ['capturedAt'], sort: EVIDENCE_CURSOR } as const;

const ID = 'identity' as const;
const EN = 'enum' as const;

/** Every read `MongoEvidenceStore` issues, transcribed from the implementation. */
const QUERIES: QueryShape[] = [
  {
    name: 'get / insert existence check — by id',
    equality: [
      ['tenantId', ID],
      ['_id', ID],
    ],
  },
  {
    name: 'patch — by id',
    equality: [
      ['tenantId', ID],
      ['_id', ID],
    ],
  },
  { name: 'list() — unfiltered, newest first', equality: [['tenantId', ID]], ...PAGED },
  {
    name: 'list({ incidentId }) — the workspace evidence panel',
    equality: [
      ['tenantId', ID],
      ['source.incidentId', ID],
    ],
    ...PAGED,
  },
  {
    name: 'list({ correlationId }) — the spine',
    equality: [
      ['tenantId', ID],
      ['source.correlationId', ID],
    ],
    ...PAGED,
  },
  {
    name: 'list({ eventId })',
    equality: [
      ['tenantId', ID],
      ['source.eventId', ID],
    ],
    ...PAGED,
  },
  {
    name: 'list({ cameraId })',
    equality: [
      ['tenantId', ID],
      ['source.cameraId', ID],
    ],
    ...PAGED,
  },
  {
    name: 'list({ kind })',
    equality: [
      ['tenantId', ID],
      ['kind', EN],
    ],
    ...PAGED,
  },
  {
    name: 'list({ kind, status })',
    equality: [
      ['tenantId', ID],
      ['kind', EN],
      ['status', EN],
    ],
    ...PAGED,
  },
  { name: 'list({ from, to }) — a time window', equality: [['tenantId', ID]], ...PAGED },
  {
    name: 'list({ incidentId, kind }) — the panel filtered to clips',
    equality: [
      ['tenantId', ID],
      ['source.incidentId', ID],
      ['kind', EN],
    ],
    ...PAGED,
  },
];

describe('every evidence query is served by a declared index (TD-25)', () => {
  it.each(QUERIES)('$name — narrowed by an index, never a tenant-wide scan', (query) => {
    expect(best(query).coverage, `"${query.name}" scans the tenant — see INDEX_POLICY`).not.toBe(
      'scan',
    );
  });

  it('names the index each query is expected to use — an executable plan document', () => {
    expect(Object.fromEntries(QUERIES.map((q) => [q.name, best(q).index?.name]))).toMatchObject({
      'get / insert existence check — by id': '_id_',
      'list() — unfiltered, newest first': 'tenant_captured',
      'list({ incidentId }) — the workspace evidence panel': 'tenant_incident',
      'list({ correlationId }) — the spine': 'tenant_correlation',
      'list({ eventId })': 'tenant_event',
      'list({ cameraId })': 'tenant_camera',
      'list({ kind, status })': 'tenant_kind_status',
    });
  });

  /**
   * `kind` alone has no index of its own and does not need one — two values, so the cursor walk
   * examines roughly twice the page size (measured: 99 examined to return 50). Indexing a
   * two-valued field costs a write on every insert and saves almost nothing.
   */
  it('records which queries ride the time index with a residual enum filter', () => {
    const bounded = QUERIES.filter((q) => best(q).coverage === 'bounded').map((q) => q.name);
    expect(bounded).toEqual([
      'list({ kind })',
      'list({ incidentId, kind }) — the panel filtered to clips',
    ]);
  });
});

describe('the evidence index set (TD-25)', () => {
  it('leads every created index with tenantId — no cross-tenant scan is possible', () => {
    for (const index of EVIDENCE_INDEXES.filter((i) => !i.implicit)) {
      expect(index.keys[0], `${index.name} must lead with tenantId`).toBe('tenantId');
    }
  });

  /**
   * The exact regression TD-25 recorded, and the one the ported model could not see:
   * `{tenantId, source.incidentId, capturedAt}` served the leading sort key and handed the `_id`
   * tiebreak to a blocking in-memory sort — on the one query the workspace always issues.
   */
  it('ends every non-implicit index with the (capturedAt, _id) cursor pair', () => {
    for (const index of EVIDENCE_INDEXES.filter((i) => !i.implicit)) {
      expect(index.keys.slice(-2), `${index.name} must end in (capturedAt, _id)`).toEqual([
        ...EVIDENCE_CURSOR,
      ]);
    }
  });

  it('declares the cursor pair descending wherever it appears, matching the sort', () => {
    for (const index of EVIDENCE_INDEXES.filter((i) => i.keys.includes('capturedAt'))) {
      expect(index.descending, `${index.name} must sort the cursor descending`).toEqual([
        ...EVIDENCE_CURSOR,
      ]);
    }
  });

  it('declares no duplicate names and no duplicate key sets', () => {
    expect(new Set(EVIDENCE_INDEXES.map((i) => i.name)).size).toBe(EVIDENCE_INDEXES.length);
    expect(new Set(EVIDENCE_INDEXES.map((i) => i.keys.join(','))).size).toBe(
      EVIDENCE_INDEXES.length,
    );
  });

  /**
   * The guard that makes this test do its job: a new `EvidenceQuery` filter without an index is the
   * defect TD-25 recorded, so the filter set is asserted and a new one fails until it is classified
   * above and — if it is an identity filter — given an index.
   */
  it('has one declared index per identity-cardinality EvidenceQuery filter', async () => {
    const { EvidenceQuery } = await import('@vip/contracts');
    const filters = Object.keys(EvidenceQuery.shape).filter(
      (key) => !['limit', 'cursor', 'from', 'to'].includes(key),
    );
    expect(filters.sort()).toEqual([
      'cameraId',
      'correlationId',
      'eventId',
      'incidentId',
      'kind',
      'status',
    ]);
    // four identity filters → four dedicated indexes, plus the cursor index and the enum compound.
    expect(EVIDENCE_INDEXES.filter((i) => !i.implicit)).toHaveLength(6);
  });
});

/**
 * The model checking itself. Both cases below are **measured** failures reproduced in the model —
 * a coverage model that cannot fail proves nothing, and this one demonstrably could not see the
 * second case until `explain()` was consulted.
 */
describe('the coverage model detects what it claims to detect', () => {
  it('calls an identity filter with no index of its own a `scan`', () => {
    expect(
      best({
        name: 'list({ label })',
        equality: [
          ['tenantId', ID],
          ['label', ID],
        ],
        ...PAGED,
      }).coverage,
    ).toBe('scan');
  });

  /**
   * ⚠️ The one that caught the model out. This index reaches `capturedAt` — the leading sort key —
   * so a model that checks only the leading key calls it `covered`. MongoDB produced a blocking
   * `SORT`, because the sort is `(capturedAt, _id)` and the index never reaches `_id`.
   */
  it('calls the pre-P-5.1 tenant_incident a `scan` — the blocking-sort defect itself', () => {
    const asItWas: IndexSpec = {
      name: 'tenant_incident (pre-P-5.1)',
      keys: ['tenantId', 'source.incidentId', 'capturedAt'],
      serves: 'the index that produced a blocking SORT',
    };
    const query = QUERIES.find((q) => q.name.startsWith('list({ incidentId })'))!;
    expect(classify(asItWas, query)).toBe('scan');
    expect(best(query).coverage).toBe('covered');
  });

  it('would also have caught it on the leading key alone, had the sort been single-keyed', () => {
    const truncated: IndexSpec = {
      name: 'tenant_incident (no time key at all)',
      keys: ['tenantId', 'source.incidentId'],
      serves: 'the naive version',
    };
    const query = QUERIES.find((q) => q.name.startsWith('list({ incidentId })'))!;
    expect(classify(truncated, query)).toBe('scan');
  });
});
