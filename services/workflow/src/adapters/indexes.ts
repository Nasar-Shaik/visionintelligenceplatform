/**
 * The `incidents` index set, declared as data so a test can prove every issued query is served —
 * **TD-22, paid down before the filters that need it were added, not after** (P-5.0 entry
 * criterion G-4).
 *
 * The debt this closes: the Workflow context created three indexes, none of which served a filtered
 * incident search, and had no coverage test. The tenant and camera services grew one in P-3
 * precisely because review had missed three such gaps by eye. Under
 * [INDEX_POLICY](../../../../docs/project/INDEX_POLICY.md) the sort key must be the key *after* the
 * equality prefix — so `{tenantId, raisedAt, id}` serves the unfiltered newest-first list and
 * **abandons the sort** the moment any filter is added. That is a blocking in-memory sort against
 * MongoDB's 32 MB limit on a year of incidents, and it looks perfectly fine against a fixture.
 *
 * Every non-unique index therefore ends in the **cursor pair** `(raisedAt, id)`, because every
 * bounded read here pages by that pair.
 */

export interface IndexSpec {
  readonly name: string;
  readonly keys: readonly string[];
  readonly serves: string;
  readonly unique?: boolean;
  /**
   * Keys created in descending order. Stated explicitly rather than inferred: `uniq_tenant_incident`
   * was created as `{tenantId:1, id:1}` in P1-8, and re-declaring an existing index name with
   * different keys is an `IndexOptionsConflict` at boot — a rule this file has to encode, not
   * remember.
   */
  readonly descending?: readonly string[];
  /** Created by MongoDB itself. Declared so the coverage model sees it; never created by us. */
  readonly implicit?: boolean;
}

/**
 * The cursor pair every bounded incident read pages by, newest first. Every index that ends in it
 * declares both keys descending, so the plan matches the sort exactly.
 */
export const INCIDENT_CURSOR = ['raisedAt', 'id'] as const;
const CURSOR_DESC = INCIDENT_CURSOR;

export const INCIDENT_INDEXES: readonly IndexSpec[] = [
  {
    name: '_id_',
    keys: ['_id'],
    serves: "MongoDB's implicit index — not used by any incident query (ids are the `id` field)",
    implicit: true,
    unique: true,
  },
  {
    name: 'uniq_tenant_incident',
    keys: ['tenantId', 'id'],
    serves: 'get by id, and the version-guarded replace behind every transition',
    unique: true,
  },
  {
    name: 'uniq_tenant_dedupkey',
    keys: ['tenantId', 'source.dedupKey'],
    serves: 'idempotent promotion — the same candidate twice collapses into one incident',
    unique: true,
  },
  {
    /* Pre-existing (P1-8). Name preserved so no production index is dropped and rebuilt. */
    name: 'tenant_raisedAt_id',
    keys: ['tenantId', 'raisedAt', 'id'],
    descending: CURSOR_DESC,
    serves: 'the unfiltered newest-first list, and the cursor walk behind every other filter',
  },
  {
    name: 'tenant_status_time',
    keys: ['tenantId', 'status', 'raisedAt', 'id'],
    descending: CURSOR_DESC,
    serves: 'the open-work queue — "everything raised", "everything still investigating"',
  },
  {
    name: 'tenant_severity_time',
    keys: ['tenantId', 'severity', 'raisedAt', 'id'],
    descending: CURSOR_DESC,
    serves: 'the triage filter — "critical first"',
  },
  {
    name: 'tenant_camera_time',
    keys: ['tenantId', 'triggeredBy.cameraId', 'raisedAt', 'id'],
    descending: CURSOR_DESC,
    serves: "one camera's incident history",
  },
  {
    name: 'tenant_zone_time',
    keys: ['tenantId', 'triggeredBy.zoneId', 'raisedAt', 'id'],
    descending: CURSOR_DESC,
    serves: 'incidents in a zone',
  },
  {
    name: 'tenant_rule_time',
    keys: ['tenantId', 'source.ruleId', 'raisedAt', 'id'],
    descending: CURSOR_DESC,
    serves: 'everything one rule has ever raised — the rule-impact view',
  },
  {
    name: 'tenant_correlation_time',
    keys: ['tenantId', 'correlationId', 'raisedAt', 'id'],
    descending: CURSOR_DESC,
    serves: 'the correlation spine — "everything related to this"',
  },
  {
    name: 'tenant_analysis_time',
    keys: ['tenantId', 'analysisSessionId', 'raisedAt', 'id'],
    descending: CURSOR_DESC,
    serves:
      'the investigation’s incident list — everything one offline analysis run raised (ADR-0047). ' +
      'Also serves the live queue’s {$exists:false} exclusion, which leads on the same field',
  },
  {
    name: 'tenant_assignee_time',
    keys: ['tenantId', 'assignee', 'raisedAt', 'id'],
    descending: CURSOR_DESC,
    serves: 'an operator\'s queue — "what is mine"',
  },
  {
    name: 'tenant_eventType_time',
    keys: ['tenantId', 'triggeredBy.eventType', 'raisedAt', 'id'],
    descending: CURSOR_DESC,
    serves: 'behaviour search, expressed as the triggering event type (`behavior.loitering`, …)',
  },
  {
    name: 'tenant_category_time',
    keys: ['tenantId', 'category', 'raisedAt', 'id'],
    descending: CURSOR_DESC,
    serves: 'the coarse taxonomy filter — safety / security / operations',
  },
] as const;

/**
 * ⚠️ **Deliberately not indexed: every *pair* of filters.**
 *
 * Nine filter keys is 36 pairs and 84 triples. Indexing the combinations would multiply write cost
 * and index memory for reads nobody has issued yet. What actually matters is that the **sort** is
 * always served — that is the difference between a bounded index walk and a blocking in-memory sort.
 * With one index chosen, any remaining predicate is a residual filter applied to documents the
 * index already located: it costs documents examined, which grows linearly and is measurable, not
 * a 32 MB cliff.
 *
 * The coverage test encodes exactly this: a query may be `covered` (every equality consumed) or
 * `bounded` (one equality consumed, the rest residual, **sort still served**) — and may never be
 * `unsorted`. If a real deployment shows one pair dominating, add that compound index and its row.
 */
export const UNINDEXED_BY_DESIGN =
  'filter combinations — one index is chosen, the rest are residual filters over an already-bounded scan';

/**
 * The `bookmarks` index set (P-5.5).
 *
 * ⚠️ The cursor pair here is `(at, id)` **ascending**, not `(raisedAt, id)` descending — a bookmark
 * list is read oldest-first, because it is a route through the footage rather than a news feed. The
 * index therefore ends in the pair the query actually sorts by, which is the whole point of
 * [INDEX_POLICY](../../../../docs/project/INDEX_POLICY.md): a sort the index does not serve is a
 * blocking in-memory sort that looks perfectly fine against a fixture.
 */
export const BOOKMARK_INDEXES: readonly IndexSpec[] = [
  {
    name: '_id_',
    keys: ['_id'],
    serves: "MongoDB's implicit index — not used by any bookmark query",
    implicit: true,
    unique: true,
  },
  {
    name: 'uniq_tenant_bookmark',
    keys: ['tenantId', 'id'],
    serves: 'get by id, and the delete behind removing a marker',
    unique: true,
  },
  {
    name: 'bookmarks_by_incident',
    keys: ['tenantId', 'incidentId', 'at', 'id'],
    serves: "an incident's bookmarks, oldest first, paged by the (at, id) cursor",
  },
];
