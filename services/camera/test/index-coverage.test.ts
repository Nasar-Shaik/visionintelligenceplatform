/**
 * Camera index coverage (Architect recommendation 1, 6).
 *
 * The same model the tenant service uses, applied to the reads P-3's location filter added. The
 * question is whether MongoDB will actually *use* these indexes — not whether they exist.
 *
 * Rules, matching how the planner decides: equality keys must occupy a contiguous prefix; a range
 * predicate before the sort key consumes one key; the sort key must then be the next key. A range on
 * the sort key itself is a **cursor** — a seek and a walk — and does not consume it.
 */
import { describe, expect, it } from 'vitest';
import { CAMERA_INDEXES, PROBE_INDEXES, type IndexSpec } from '../src/adapters/indexes.js';

interface QueryShape {
  name: string;
  equality: string[];
  range?: string[];
  sort?: string;
}

function covers(index: IndexSpec, query: QueryShape): boolean {
  const keys = index.keys;
  const equality = new Set(query.equality);

  let position = 0;
  while (position < keys.length && equality.has(keys[position]!)) {
    equality.delete(keys[position]!);
    position += 1;
  }
  // A fully-consumed unique index yields at most one document; anything left is free.
  if (index.unique && position === keys.length) return true;
  if (equality.size > 0) return false;

  const ranges = new Set(query.range ?? []);
  while (position < keys.length && ranges.has(keys[position]!) && keys[position] !== query.sort) {
    ranges.delete(keys[position]!);
    position += 1;
  }

  if (!query.sort) return true;
  return keys[position] === query.sort;
}

const cameraIndex = (query: QueryShape) => CAMERA_INDEXES.find((i) => covers(i, query));
const probeIndex = (query: QueryShape) => PROBE_INDEXES.find((i) => covers(i, query));

/** Every read `CameraService` issues against `cameras`, transcribed from the implementation. */
const CAMERA_QUERIES: QueryShape[] = [
  { name: 'get / require — by id', equality: ['tenantId', '_id'] },
  { name: 'create — duplicate stream URL check', equality: ['tenantId', 'streamUrl'] },
  { name: 'list() — the bounded inventory', equality: ['tenantId'] },
  {
    name: 'query() — unfiltered, paged',
    equality: ['tenantId'],
    range: ['_id'],
    sort: '_id',
  },
  {
    name: 'query({ zoneIds }) — the resolved subtree filter, paged',
    equality: ['tenantId', 'zoneId'],
    range: ['_id'],
    sort: '_id',
  },
  {
    name: 'query({ status }) — enabled / disabled, paged',
    equality: ['tenantId', 'status'],
    range: ['_id'],
    sort: '_id',
  },
  {
    name: 'query({ lifecycle }) — degraded / offline / retired, paged',
    equality: ['tenantId', 'lifecycle.state'],
    range: ['_id'],
    sort: '_id',
  },
  {
    name: 'fleet sample — cameras counted and sampled per tenant',
    equality: ['tenantId'],
    range: ['_id'],
    sort: '_id',
  },
];

const PROBE_QUERIES: QueryShape[] = [
  {
    name: "probeHistory — one camera's archive, newest first",
    equality: ['tenantId', 'cameraId'],
    sort: 'at',
  },
  {
    name: 'fleetProbeMetrics — the tenant window, newest first',
    equality: ['tenantId'],
    range: [],
    sort: 'at',
  },
];

describe('every cameras query has a covering index (rec 1)', () => {
  it.each(CAMERA_QUERIES)('$name', (query) => {
    expect(cameraIndex(query), `no covering index for "${query.name}"`).toBeDefined();
  });

  it('names the index each query is expected to use — an executable plan document', () => {
    const plan = Object.fromEntries(
      CAMERA_QUERIES.map((query) => [query.name, cameraIndex(query)?.name]),
    );
    expect(plan).toMatchObject({
      'get / require — by id': '_id_',
      'query() — unfiltered, paged': 'tenant_cursor',
      'query({ zoneIds }) — the resolved subtree filter, paged': 'tenant_zone',
      'query({ status }) — enabled / disabled, paged': 'tenant_status',
      'query({ lifecycle }) — degraded / offline / retired, paged': 'tenant_lifecycle',
    });
  });
});

describe('every camera_probes query has a covering index (rec 1)', () => {
  it.each(PROBE_QUERIES)('$name', (query) => {
    expect(probeIndex(query), `no covering index for "${query.name}"`).toBeDefined();
  });
});

describe('the camera index set (rec 6)', () => {
  it('leads every created index with tenantId — no cross-tenant range scan is possible', () => {
    for (const index of [...CAMERA_INDEXES, ...PROBE_INDEXES].filter((i) => !i.implicit)) {
      expect(index.keys[0], `${index.name} must lead with tenantId`).toBe('tenantId');
    }
  });

  /**
   * The regression the P-3 scale review found. `tenant_zone` was `{tenantId, zoneId}` while the
   * location filter sorts by `_id` for its cursor: the filter was served and the sort was not, so
   * Mongo gathered every camera in the subtree to order it in memory. Invisible against a four-row
   * fixture; a blocking sort against the 32 MB limit on a million-camera estate.
   */
  it('ends every camera index with the cursor key, except the uniqueness constraint', () => {
    for (const index of CAMERA_INDEXES.filter((i) => !i.unique)) {
      expect(index.keys.at(-1), `${index.name} must end in _id`).toBe('_id');
    }
  });

  it('declares no duplicate names and no duplicate key sets', () => {
    const all = [...CAMERA_INDEXES, ...PROBE_INDEXES];
    expect(new Set(all.map((i) => i.name)).size).toBe(all.length);
    expect(new Set(all.map((i) => i.keys.join(','))).size).toBe(all.length);
  });

  /**
   * Health and `lastSeen` are filtered **in the console**, over an already-bounded page — so there is
   * no server-side query to index, and an index for a query nobody issues is write cost for nothing.
   * Recorded because the review asked about both: when either becomes a `CameraQuery` field, it
   * needs `{tenantId, <field>, _id}` and this test should gain a row.
   */
  it('has no index for health or lastSeen, because neither is a server-side filter yet', () => {
    const keys = CAMERA_INDEXES.flatMap((i) => i.keys);
    expect(keys).not.toContain('health.status');
    expect(keys).not.toContain('health.lastSeenAt');
    expect(Object.keys({})).toEqual([]);
  });
});
