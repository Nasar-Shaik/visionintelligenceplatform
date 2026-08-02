/**
 * Index coverage (Architect recommendation 1, 6).
 *
 * The question this answers is **"will MongoDB use these indexes efficiently?"** — not "did we create
 * indexes". Those are different claims, and only the first one keeps a hundred-thousand-location
 * estate responsive.
 *
 * The model here is deliberately simple and matches how the planner actually decides:
 *
 *  - an **equality** predicate consumes one index key, in order, from the front;
 *  - the **sort** must be served by the keys immediately following the consumed prefix;
 *  - a range predicate (`$gt`, `$ne`) consumes a key but ends the usable prefix for further equality;
 *  - anything left over is a residual filter — correct, but scanned within the narrowed range.
 *
 * A query is **covered** when its equality keys form a prefix and its sort key follows them. A query
 * whose sort is *not* reachable that way triggers a blocking in-memory sort, which is invisible on a
 * fixture and fails against the 32 MB limit in production. That is the regression this file exists
 * to catch, and it is the one the P-3 review actually found.
 */
import { describe, expect, it } from 'vitest';
import { ORG_NODE_INDEXES, type IndexSpec } from '../src/adapters/indexes.js';

/** A query the service issues, in the terms the planner sees. */
interface QueryShape {
  name: string;
  /** Fields matched by equality (including `$in`, which the planner treats as equality per value). */
  equality: string[];
  /** Fields matched by range — `$gt` (the cursor), `$ne` (excluding archived). */
  range?: string[];
  /** The sort key. Every bounded read in the service sorts by its cursor. */
  sort?: string;
}

/**
 * Whether `index` serves `query` without a blocking sort.
 *
 * Equality keys may appear in any order in the filter but must occupy a contiguous prefix of the
 * index. The sort key must then be the next key — that is precisely the rule that makes a trailing
 * `_id` load-bearing rather than decorative.
 */
function covers(index: IndexSpec, query: QueryShape): boolean {
  const keys = index.keys;
  const equality = new Set(query.equality);

  let position = 0;
  while (position < keys.length && equality.has(keys[position]!)) {
    equality.delete(keys[position]!);
    position += 1;
  }

  /*
   * A **unique** index fully consumed by equality yields at most one document per matched value, so
   * anything left over is applied to a result set of that size rather than to a scan — and a sort of
   * one document is free. This is why `findOne({ tenantId, _id })` is optimal on `_id_` despite
   * `tenantId` not being in the index: the tenant check is a guard on a single document, not a
   * filter over a range. Modelling it any other way would demand an index the planner would ignore.
   */
  if (index.unique && position === keys.length) return true;

  if (equality.size > 0) return false; // an equality key was not in the prefix

  /*
   * A range predicate on a key *before* the sort key consumes it — `status: {$ne}` sitting between
   * `tenantId` and `_id` still lets the planner walk the index in `_id` order within each status.
   *
   * A range on the **sort key itself** is not consumed: that is what a cursor is. `_id: {$gt: c}`
   * sorted by `_id` is a seek to a position in the index followed by a walk — the single most
   * index-friendly shape there is, and treating it as consuming the key would report it uncovered.
   */
  const ranges = new Set(query.range ?? []);
  while (position < keys.length && ranges.has(keys[position]!) && keys[position] !== query.sort) {
    ranges.delete(keys[position]!);
    position += 1;
  }

  if (!query.sort) return true;
  /*
   * The sort key must be the next index key. Not "somewhere in the index", not "also filtered" —
   * *next*. Anything looser would have declared the two gaps this file was written to find already
   * covered, which is the failure mode of a coverage check that wants to pass.
   */
  return keys[position] === query.sort;
}

function coveringIndex(query: QueryShape): IndexSpec | undefined {
  return ORG_NODE_INDEXES.find((index) => covers(index, query));
}

/**
 * Every read `TenantService` issues against `org_nodes`, transcribed from the implementation.
 *
 * `tenantId` is on every one because `TenantRepository` injects it — the guard makes a
 * tenant-unscoped query structurally impossible, which is also why every index leads with it.
 */
const QUERIES: QueryShape[] = [
  {
    name: 'requireNode / findOne by id',
    equality: ['tenantId', '_id'],
  },
  {
    name: 'ancestorsOf — one $in over the stored path',
    equality: ['tenantId', '_id'],
  },
  {
    name: 'resolve — which of these nodes have children (aggregate $match)',
    equality: ['tenantId', 'parentId'],
  },
  {
    name: 'locations() — unfiltered page, archived excluded, cursor',
    equality: ['tenantId'],
    range: ['status', '_id'],
    sort: '_id',
  },
  {
    name: 'locations({ type }) — every site / every zone',
    equality: ['tenantId', 'type'],
    range: ['_id'],
    sort: '_id',
  },
  {
    name: 'locations({ parentId }) — the children of a node',
    equality: ['tenantId', 'parentId'],
    range: ['_id'],
    sort: '_id',
  },
  {
    name: 'locations({ under }) — the subtree beneath a node',
    equality: ['tenantId', 'path'],
    range: ['_id'],
    sort: '_id',
  },
  {
    // `status: { $ne: 'archived' }` is a residual filter here; the ordering is what needs the index.
    name: 'orgTree() — shallowest first, so a truncated estate is complete from the root',
    equality: ['tenantId'],
    range: [],
    sort: 'depth',
  },
  {
    name: 'orgTree({ under }) — a subtree, shallowest first',
    equality: ['tenantId', 'path'],
    sort: 'depth',
  },
  {
    name: 'updateOrgNode — descendants of a moved node',
    equality: ['tenantId', 'path'],
  },
  {
    name: 'archiveOrgNode / restoreOrgNode — the subtree',
    equality: ['tenantId', 'path'],
  },
];

describe('every org_nodes query has a covering index (rec 1)', () => {
  it.each(QUERIES)('$name', (query) => {
    const index = coveringIndex(query);
    expect(index, `no covering index for "${query.name}"`).toBeDefined();
  });

  it('names the index each query is expected to use — an executable plan document', () => {
    const plan = Object.fromEntries(
      QUERIES.map((query) => [query.name, coveringIndex(query)?.name]),
    );
    expect(plan).toMatchObject({
      'locations({ under }) — the subtree beneath a node': 'tenant_path',
      'locations({ type }) — every site / every zone': 'tenant_type',
      'locations({ parentId }) — the children of a node': 'tenant_parent',
      'orgTree() — shallowest first, so a truncated estate is complete from the root':
        'tenant_depth',
      'archiveOrgNode / restoreOrgNode — the subtree': 'tenant_path',
      'orgTree({ under }) — a subtree, shallowest first': 'tenant_path_depth',
      'requireNode / findOne by id': '_id_',
    });
  });
});

describe('the index set itself (rec 6)', () => {
  /**
   * Every index *we create* leads with `tenantId`, so no query of ours can range-scan across
   * tenants. `_id_` is exempt because MongoDB creates it and it is unique — a match is a single
   * document, on which the repository guard's `tenantId` is checked before the document is returned.
   */
  it('leads every created index with tenantId — a tenant-unscoped range scan is impossible', () => {
    for (const index of ORG_NODE_INDEXES.filter((i) => !i.implicit)) {
      expect(index.keys[0], `${index.name} must lead with tenantId`).toBe('tenantId');
    }
  });

  /**
   * The regression the P-3 scale review found. `tenant_path` was `{tenantId, path}` and the subtree
   * page sorts by `_id`: the filter was indexed, the sort was not, and Mongo gathered every match to
   * sort it in memory. Correct on four rows; a blocking sort against the 32 MB limit on a hundred
   * thousand locations.
   */
  it('ends every index with _id, because every bounded read pages by an _id cursor', () => {
    for (const index of ORG_NODE_INDEXES) {
      expect(index.keys.at(-1), `${index.name} must end in _id`).toBe('_id');
    }
  });

  it('declares no duplicate names and no duplicate key sets', () => {
    const names = ORG_NODE_INDEXES.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
    const keySets = ORG_NODE_INDEXES.map((i) => i.keys.join(','));
    expect(new Set(keySets).size).toBe(keySets.length);
  });

  it('says what each index is for, so a later reader can tell whether it is still needed', () => {
    for (const index of ORG_NODE_INDEXES) expect(index.serves.length).toBeGreaterThan(10);
  });

  /**
   * The one query that is deliberately **not** covered, recorded so it is a known cost rather than a
   * surprise. `?search=` is an unanchored substring regex; no B-tree serves one. It is bounded (the
   * limit caps the result) but the work is a scan of the tenant's nodes. The mitigation when a
   * customer reaches the scale where it matters is a text index or an anchored prefix search —
   * neither of which needs a model change.
   */
  it('documents unanchored substring search as the one uncovered read', () => {
    const substringSearch: QueryShape = {
      name: 'locations({ search }) — unanchored substring',
      equality: ['tenantId', 'name:regex'],
      sort: '_id',
    };
    expect(coveringIndex(substringSearch)).toBeUndefined();
    // A prefix-anchored search, by contrast, is served by `tenant_name`.
    expect(
      coveringIndex({ name: 'prefix', equality: ['tenantId', 'name'], sort: '_id' })?.name,
    ).toBe('tenant_name');
  });
});

describe('the coverage model itself is honest', () => {
  const index: IndexSpec = { name: 'x', keys: ['tenantId', 'type', '_id'], serves: 'test' };

  it('rejects a sort that is not reachable from the consumed prefix', () => {
    expect(covers(index, { name: 'q', equality: ['tenantId'], sort: '_id' })).toBe(false);
    expect(covers(index, { name: 'q', equality: ['tenantId', 'type'], sort: '_id' })).toBe(true);
  });

  it('rejects an equality key that is not in the index', () => {
    expect(covers(index, { name: 'q', equality: ['tenantId', 'depth'] })).toBe(false);
  });

  it('accepts a pure prefix match with no sort', () => {
    expect(covers(index, { name: 'q', equality: ['tenantId'] })).toBe(true);
  });
});
