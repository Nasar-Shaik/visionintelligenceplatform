/**
 * The `events` index set, declared as data so a test can prove every issued query is served
 * (P-5.0 entry criterion G-5, Architect rec 6 — "never expose a query without index validation").
 *
 * Two indexes here are new, and both exist because of a single P-5 feature: the investigation
 * workspace answers _why did this rule fire_, which needs the **triggering event by id** and then
 * **every event on the same correlation**. Neither had an index — a by-id lookup was a collection
 * scan nothing would have noticed until an operator opened an incident on a year-old estate.
 *
 * Every non-unique index ends in the cursor pair `(occurredAt, id)`, because that is what
 * `GET /events` pages by.
 */

export interface IndexSpec {
  readonly name: string;
  readonly keys: readonly string[];
  readonly serves: string;
  readonly unique?: boolean;
  readonly descending?: readonly string[];
  /** Created by MongoDB itself. Declared so the coverage model sees it; never created by us. */
  readonly implicit?: boolean;
}

/** The cursor pair every bounded event read pages by, newest first. */
export const EVENT_CURSOR = ['occurredAt', 'id'] as const;
const CURSOR_DESC = EVENT_CURSOR;

export const EVENT_INDEXES: readonly IndexSpec[] = [
  {
    name: '_id_',
    keys: ['_id'],
    serves: "MongoDB's implicit index — unused here; an event's identity is its `id` field",
    implicit: true,
    unique: true,
  },
  {
    name: 'uniq_tenant_dedup',
    keys: ['tenantId', 'dedupKey'],
    serves: 'idempotent ingest — a redelivered envelope collapses instead of duplicating',
    unique: true,
  },
  {
    /*
     * ⚠️ Deliberately **not unique**, though an envelope id is a UUID and a collision would be a
     * defect. `persist` maps a duplicate-key error to "already stored" and skips re-publishing; a
     * unique index here would route a genuine id collision down that same silent path and drop a
     * real event. Uniqueness is `dedupKey`'s job and stays there. This index exists purely so the
     * by-id lookup is a seek rather than a scan — no ingest behaviour changes.
     */
    name: 'tenant_event_id',
    keys: ['tenantId', 'id'],
    serves: 'GET /events/:id — the investigation workspace fetching an incident’s triggering event',
  },
  {
    name: 'tenant_occurredAt',
    keys: ['tenantId', 'occurredAt', 'id'],
    descending: CURSOR_DESC,
    serves: 'the unfiltered newest-first read and replay windows',
  },
  {
    name: 'tenant_type_time',
    keys: ['tenantId', 'type', 'occurredAt', 'id'],
    descending: CURSOR_DESC,
    serves: 'the event-type filter, paged by cursor',
  },
  {
    name: 'tenant_camera_time',
    keys: ['tenantId', 'cameraId', 'occurredAt', 'id'],
    descending: CURSOR_DESC,
    serves: "one camera's event history, paged by cursor",
  },
  {
    name: 'tenant_zone_time',
    keys: ['tenantId', 'zoneId', 'occurredAt', 'id'],
    descending: CURSOR_DESC,
    serves: 'events in a zone — a filter that already existed with no index behind it',
  },
  {
    name: 'tenant_correlation_time',
    keys: ['tenantId', 'correlationId', 'occurredAt', 'id'],
    descending: CURSOR_DESC,
    serves: 'the correlation spine — every event belonging to one incident’s chain',
  },
  {
    name: 'tenant_analysis_time',
    keys: ['tenantId', 'analysisSessionId', 'occurredAt', 'id'],
    descending: CURSOR_DESC,
    serves:
      'the investigation timeline — every event one offline analysis run produced (ADR-0047). ' +
      'Sparse in effect: live events carry no analysisSessionId, so they occupy no entry',
  },
] as const;
