/**
 * The `cameras` index set, declared as data so a test can prove every issued query is covered.
 *
 * Same rule as the location hierarchy: **every index ends in `_id`**, because every bounded read
 * pages by an `_id` cursor and an index that stops at the filter key leaves the sort to be done in
 * memory. On a million-camera estate that is a blocking sort against MongoDB's 32 MB limit — and it
 * looks perfectly fine against a four-row fixture, which is exactly why this is asserted rather than
 * remembered.
 */
export interface IndexSpec {
  readonly name: string;
  readonly keys: readonly string[];
  readonly serves: string;
  readonly unique?: boolean;
  /** Created by MongoDB itself. Declared so the coverage model sees it; never created by us. */
  readonly implicit?: boolean;
}

export const CAMERA_INDEXES: readonly IndexSpec[] = [
  {
    /** MongoDB's implicit unique index — `get`, `update` and every by-id read. */
    name: '_id_',
    keys: ['_id'],
    serves: 'findOne by camera id',
    implicit: true,
    unique: true,
  },
  {
    /*
     * The unfiltered paged read. `GET /cameras?limit=…` with no other filter sorts by `_id` and has
     * no equality key beyond the tenant, so no filter-leading index serves it — every one of those
     * needs its own key matched first. Found by the coverage model: without this, the most basic
     * paged listing an operator can issue is the one query that sorts in memory.
     */
    name: 'tenant_cursor',
    keys: ['tenantId', '_id'],
    serves: 'the unfiltered paged listing, and the cursor walk behind every other filter',
  },
  {
    name: 'uniq_tenant_stream',
    keys: ['tenantId', 'streamUrl'],
    serves: 'idempotent onboarding — the same stream URL twice in a tenant is a 409',
    unique: true,
  },
  {
    name: 'tenant_zone',
    keys: ['tenantId', 'zoneId', '_id'],
    serves:
      'cameras in a zone, and cameras under a subtree (`zoneId: {$in: […]}`) — the resolved ' +
      'location filter, paged by cursor',
  },
  {
    name: 'tenant_status',
    keys: ['tenantId', 'status', '_id'],
    serves: 'the enabled/disabled filter, paged by cursor',
  },
  {
    name: 'tenant_lifecycle',
    keys: ['tenantId', 'lifecycle.state', '_id'],
    serves: 'the lifecycle filter — "every degraded camera", "everything not retired"',
  },
  {
    name: 'tenant_name',
    keys: ['tenantId', 'name', '_id'],
    serves: 'name ordering and prefix search (an unanchored substring search still scans)',
  },
] as const;

export const PROBE_INDEXES: readonly IndexSpec[] = [
  {
    name: 'tenant_camera_at',
    keys: ['tenantId', 'cameraId', 'at'],
    serves: "one camera's probe archive, newest first",
  },
  {
    name: 'tenant_at',
    keys: ['tenantId', 'at'],
    serves: 'the fleet probe aggregate over a time window',
  },
] as const;
