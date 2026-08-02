/**
 * The `org_nodes` index set, declared as **data** rather than as a sequence of calls.
 *
 * Declaring them this way is what lets a test assert that every query the service actually issues is
 * served by one of them — "we created some indexes" is not the same claim as "the planner will use
 * them", and only the second one keeps a production estate responsive. See
 * `test/index-coverage.test.ts`, which fails if a query pattern is added without a covering index.
 *
 * **Every index ends in `_id`.** Each bounded read pages by an `_id` cursor, and an index that stops
 * at the filter key serves the filter while leaving MongoDB to sort the matches in memory. That is
 * invisible against a test fixture and a blocking sort against the 32 MB limit on a tenant with a
 * hundred thousand locations. With the trailing `_id` the planner walks each range already in cursor
 * order — the page costs O(page), not O(matches).
 */
export interface IndexSpec {
  /** Index name, as created. */
  readonly name: string;
  /** Keys in order. Order is the whole point: a prefix serves a filter, the tail serves the sort. */
  readonly keys: readonly string[];
  /** The query pattern this exists for, in the words the service uses. */
  readonly serves: string;
  /** Whether the indexed field is an array (multikey). */
  readonly multikey?: boolean;
  /** Created by MongoDB itself. Declared so the coverage model sees it; never created by us. */
  readonly implicit?: boolean;
  /** Unique: a full match yields at most one document, so any remaining predicate is free. */
  readonly unique?: boolean;
}

export const ORG_NODE_INDEXES: readonly IndexSpec[] = [
  {
    /*
     * MongoDB's implicit unique index. Declared here because it is load-bearing for two reads —
     * fetching a node by id, and resolving ancestors with one `$in` over the stored path — and an
     * index the coverage model cannot see is one it will wrongly report as missing.
     */
    name: '_id_',
    keys: ['_id'],
    serves: 'findOne by id · ancestorsOf ($in over the materialized path)',
    implicit: true,
    unique: true,
  },
  {
    name: 'tenant_parent',
    keys: ['tenantId', 'parentId', '_id'],
    serves: 'children(node) · siblings(node) · the parentId filter on /locations',
  },
  {
    name: 'tenant_type',
    keys: ['tenantId', 'type', '_id'],
    serves: 'the type filter on /locations — "every site", "every zone"',
  },
  {
    name: 'tenant_path',
    keys: ['tenantId', 'path', '_id'],
    serves: 'under(node) · descendants(node) · within(node,type) · subtree archive and move',
    multikey: true,
  },
  {
    /*
     * A subtree read filters on `path` and orders by `depth` — so that a truncated estate is complete
     * from the root downward rather than missing its middle. `tenant_path` cannot serve that sort:
     * its next key is `_id`, so the planner would gather every match and order it in memory. Bounded
     * by the tree limit, but the *matches* are not bounded — a 100,000-node subtree gets sorted to
     * return 5,000. Found by the coverage model, not by review.
     */
    name: 'tenant_path_depth',
    keys: ['tenantId', 'path', 'depth', '_id'],
    serves: 'the subtree tree read — under(node) ordered shallowest-first',
    multikey: true,
  },
  {
    name: 'tenant_depth',
    keys: ['tenantId', 'depth', '_id'],
    serves: 'the shallowest-first tree read, so a truncated estate is complete from the root down',
  },
  {
    name: 'tenant_status',
    keys: ['tenantId', 'status', '_id'],
    serves: 'excluding archived locations from working views without scanning them',
  },
  {
    name: 'tenant_name',
    keys: ['tenantId', 'name', '_id'],
    serves: 'name ordering and prefix search (an unanchored substring search still scans)',
  },
] as const;
