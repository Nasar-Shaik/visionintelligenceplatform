/**
 * The `evidence` index set, declared as data so a test can prove every issued query is served —
 * **TD-25, paid before the investigation workspace that needs it** (P-5.1, Architect-approved F-1).
 *
 * ### What was actually wrong, measured rather than inferred
 *
 * The three indexes this replaces were `{tenantId, capturedAt, _id}`,
 * `{tenantId, 'source.incidentId', capturedAt}` and `{tenantId, kind, status, capturedAt}`. Read as
 * a list they look reasonable. Explained against a real MongoDB with `executionStats`, they were
 * two different defects:
 *
 * | Query (sorted `capturedAt, _id`) | Index chosen      | Blocking `SORT` | Examined / returned |
 * | -------------------------------- | ----------------- | --------------- | ------------------- |
 * | `incidentId` — the workspace     | `tenant_incident` | **yes**         | 10 / 10             |
 * | `correlationId` — the spine      | `tenant_captured` | no              | **399 / 50**        |
 * | `eventId`                        | `tenant_captured` | no              | **500 / 1**         |
 * | `cameraId`                       | `tenant_captured` | no              | **497 / 50**        |
 *
 * 1. `tenant_incident` stopped at `capturedAt` and never reached `_id`, so it served the leading
 *    sort key and handed the tiebreak to an **in-memory sort** against MongoDB's 32 MB ceiling —
 *    on the one query the workspace always issues.
 * 2. `eventId`, `correlationId` and `cameraId` had no index at all — and produced **no `COLLSCAN`**,
 *    because the planner fell back to the time index. The sort was served and only the predicates
 *    were residual, which is exactly why reading the index list understated it. `eventId` examined
 *    **all 500 documents to return 1**, and that ratio grows with the tenant's whole evidence
 *    history. At the 10 M-reference target it is the difference between a panel and an outage.
 *
 * Every non-unique index therefore ends in the **cursor pair** `(capturedAt, _id)`, because that is
 * what `list()` pages by.
 */

export interface IndexSpec {
  readonly name: string;
  readonly keys: readonly string[];
  readonly serves: string;
  readonly unique?: boolean;
  /**
   * Keys created descending. Stated explicitly: three of these names already exist in deployed
   * databases with a **different key set**, and re-declaring a name with different keys is an
   * `IndexOptionsConflict` that fails the service at boot. `ensureIndexes` reconciles.
   */
  readonly descending?: readonly string[];
  /** Created by MongoDB itself. Declared so the coverage model sees it; never created by us. */
  readonly implicit?: boolean;
}

/** The cursor pair every bounded evidence read pages by, newest first. */
export const EVIDENCE_CURSOR = ['capturedAt', '_id'] as const;
const CURSOR_DESC = EVIDENCE_CURSOR;

export const EVIDENCE_INDEXES: readonly IndexSpec[] = [
  {
    name: '_id_',
    keys: ['_id'],
    serves: 'get by evidence id, and the idempotent-insert existence check',
    implicit: true,
    unique: true,
  },
  {
    /* ⚠️ Key set changed in P-5.1: `_id` was already present. Declared so the reconcile is a no-op. */
    name: 'tenant_captured',
    keys: ['tenantId', 'capturedAt', '_id'],
    descending: CURSOR_DESC,
    serves: 'the unfiltered newest-first listing, and the time window',
  },
  {
    /* ⚠️ Key set changed in P-5.1: gained `_id`. Was producing a blocking SORT without it. */
    name: 'tenant_incident',
    keys: ['tenantId', 'source.incidentId', 'capturedAt', '_id'],
    descending: CURSOR_DESC,
    serves: "the investigation workspace's evidence panel — evidence for one incident",
  },
  {
    /* ⚠️ New in P-5.1. The correlation walk had no index and examined the tenant's whole history. */
    name: 'tenant_correlation',
    keys: ['tenantId', 'source.correlationId', 'capturedAt', '_id'],
    descending: CURSOR_DESC,
    serves: 'the correlation spine — every artefact belonging to one incident chain',
  },
  {
    /* ⚠️ New in P-5.1. `eventId` examined 500 documents to return 1. */
    name: 'tenant_event',
    keys: ['tenantId', 'source.eventId', 'capturedAt', '_id'],
    descending: CURSOR_DESC,
    serves: 'evidence captured for one specific event',
  },
  {
    /* ⚠️ New in P-5.1. A filter that had existed since P1 with nothing behind it. */
    name: 'tenant_camera',
    keys: ['tenantId', 'source.cameraId', 'capturedAt', '_id'],
    descending: CURSOR_DESC,
    serves: "one camera's evidence history",
  },
  {
    /* ⚠️ Key set changed in P-5.1: gained `_id`. */
    name: 'tenant_kind_status',
    keys: ['tenantId', 'kind', 'status', 'capturedAt', '_id'],
    descending: CURSOR_DESC,
    serves: 'the kind + lifecycle filter — "every available clip"',
  },
] as const;

/**
 * ⚠️ **Deliberately not indexed: filter combinations.**
 *
 * Six filter keys is fifteen pairs. What matters is that the **sort** is always served and that the
 * index narrows past the tenant — after that a remaining predicate is residual over an already
 * bounded set, which costs documents examined and shows up in `explain()` long before it hurts.
 * `tenant_kind_status` is the one compound kept, because `kind` alone is ~50% selective and the two
 * are almost always asked together.
 */
export const UNINDEXED_BY_DESIGN =
  'filter combinations beyond (kind, status) — one index narrows, the rest are residual';
