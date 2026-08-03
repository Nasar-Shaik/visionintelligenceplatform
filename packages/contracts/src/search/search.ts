/**
 * Unified search contracts (P-5.2.0, Architect rec 6) — **one abstraction, no search engine, and no
 * fabricated relevance**.
 *
 * The instruction was: define a platform-wide search abstraction, and do not create a separate
 * search implementation per module. This contract does that. What it deliberately does *not* do is
 * imply an index tier the platform does not have.
 *
 * ### ⚠️ Four decisions, each of which changes what can be shipped
 *
 * **1. Search is a federation, not a service.** There is no new service (a standing constraint) and
 * no Elasticsearch. A search fans out to the contexts that already own the records, each answering
 * from its own indexed query surface. That makes it a cross-context read, so it inherits the
 * `IncidentTimeline` discipline exactly: a **call budget**, a **timeout per call**, and **typed
 * gaps** for everything missing (CONSTRAINTS §63).
 *
 * **2. There is no global relevance score.** Ranking incidents against cameras requires a single
 * scorer over one index. Federating means each context orders by its own criterion, and a blended
 * number across them would be arithmetic on incomparable quantities — a score nobody can take apart
 * (§52), which people learn to distrust and then ignore. Results are therefore **grouped by entity**
 * and each group states the ordering it used. That is less impressive and it is true.
 *
 * **3. An entity is searchable only if a covering index says so.** Entry criterion G-4 was explicit:
 * *never expose a query without index validation*. Text matching on an unindexed field is a
 * collection scan that passes every fixture and melts a tenant with a year of history. So every
 * entity declares **how** it matches text (`SearchMatchMode`), and an entity with no indexed way to
 * match declares itself unsupported rather than scanning.
 *
 * **4. Four of the requested entities are not four entities.** Site, Building, Floor and Zone are
 * one entity — an `OrgNode` with a `type` — and modelling them separately would copy the Location
 * Hierarchy's frozen type enum into this contract, leaving two enums to keep in sync forever. And
 * `Actor` is not an entity at all: it is a typed *reference* (`IncidentActorRef`). Searching for a
 * person means searching operators; searching for what a person did means filtering incidents by
 * assignee. Both are recorded below rather than silently dropped.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId } from '../common/primitives.js';
import { EventPriority } from '../events/priority.js';

/**
 * Everything the platform can be asked about. **Extends additively** — a consumer that meets an
 * unknown entity ignores that group.
 */
export const SearchEntityKind = z.enum([
  'incident',
  'camera',
  'evidence',
  'rule',
  /** ⚠️ One entity, not four. Site / Building / Floor / Zone are its `type` (decision 4). */
  'location',
  'event',
  'recording',
  'clip',
  'operator',
  'investigation',
  'saved-search',
]);
export type SearchEntityKind = z.infer<typeof SearchEntityKind>;

/**
 * ⚠️ **Requested and deliberately absent.** Listed so the omission reads as a decision.
 *
 * - `actor` — not an entity. `IncidentActorRef` is a reference to a principal (Identity) or a
 *   machine; it has no record of its own to return. Use `operator`, or filter incidents by
 *   `assignee`.
 * - `site` / `building` / `floor` / `zone` — the `type` of a `location` (decision 4).
 */
export const REFUSED_SEARCH_ENTITIES = ['actor', 'site', 'building', 'floor', 'zone'] as const;

/**
 * **How** an entity matches free text — the field that decides whether a search is honest.
 *
 * - `id-exact` — the text is treated as an identifier and looked up by primary key. Always safe.
 * - `prefix-indexed` — an anchored prefix over an indexed field. Uses the index; `^abc` does,
 *   `.*abc.*` does not, which is exactly why the mode is declared rather than assumed.
 * - `text-index` — a real full-text index exists on the collection.
 * - `filter-only` — no text matching. The entity is searchable by structured filters and says so,
 *   instead of pretending a keyword box works on it.
 * - `none` — not searchable at all in this deployment.
 */
export const SearchMatchMode = z.enum([
  'id-exact',
  'prefix-indexed',
  'text-index',
  'filter-only',
  'none',
]);
export type SearchMatchMode = z.infer<typeof SearchMatchMode>;

/** What a group was ordered by. Stated per group, because it differs per context (decision 2). */
export const SearchOrdering = z.enum([
  /** Newest first — the default everywhere, and the only one most contexts can offer cheaply. */
  'recency',
  /** Lexicographic by display name. */
  'name',
  /** Ranked by the owning context's own scorer. Only ever *within* a group. */
  'relevance',
]);
export type SearchOrdering = z.infer<typeof SearchOrdering>;

/**
 * What one entity can actually answer. Declared as data so a test can assert that **every
 * searchable entity has an indexed match mode** — the mechanical form of entry criterion G-4.
 */
export const SearchEntityCapability = z.object({
  entity: SearchEntityKind,
  /** The context that answers for it. */
  owner: z.enum([
    'workflow',
    'camera',
    'evidence',
    'rules',
    'tenant',
    'events',
    'media',
    'identity',
  ]),
  /** ⚠️ False ⇒ the entity is not queried at all, and a gap says so. */
  supported: z.boolean(),
  match: SearchMatchMode,
  ordering: SearchOrdering,
  /** Structured filters this entity accepts, each of which must be index-backed. */
  filters: z.array(z.string().min(1)).default([]),
  /** ⚠️ Required when `supported` is false, or when `match` is `filter-only`/`none`. */
  limitation: z.string().min(1).max(300).optional(),
});
export type SearchEntityCapability = z.infer<typeof SearchEntityCapability>;

/**
 * **The frozen capability register** (P-5.2.0). What the platform can be asked, and — for the rest
 * — precisely why not.
 *
 * Every `supported: true` row below is backed by an existing declared index (`adapters/indexes.ts`
 * in the owning service) and its coverage test. Nothing here is aspirational: an entity becomes
 * searchable by adding its index and its coverage row, not by flipping this boolean.
 */
export const SEARCH_ENTITIES: readonly SearchEntityCapability[] = [
  {
    entity: 'incident',
    owner: 'workflow',
    supported: true,
    match: 'filter-only',
    ordering: 'recency',
    filters: [
      'status',
      'severity',
      'category',
      'eventType',
      'cameraId',
      'zoneId',
      'ruleId',
      'correlationId',
      'assignee',
      'from',
      'to',
    ],
    limitation:
      'No text index on title. `IncidentQuery` is the frozen, fully-indexed filter surface (P-5.0 G-3); free text would be an unindexed regex over the tenant history.',
  },
  {
    entity: 'camera',
    owner: 'camera',
    supported: true,
    match: 'prefix-indexed',
    ordering: 'name',
    filters: ['status', 'locationId', 'protocol'],
  },
  {
    entity: 'evidence',
    owner: 'evidence',
    supported: true,
    match: 'filter-only',
    ordering: 'recency',
    filters: ['kind', 'status', 'cameraId', 'incidentId', 'eventId', 'correlationId', 'from', 'to'],
    limitation:
      'Evidence carries no searchable title. It is found through the incident, camera or correlation it belongs to — which is how an investigator actually looks for it.',
  },
  {
    entity: 'rule',
    owner: 'rules',
    supported: true,
    match: 'prefix-indexed',
    ordering: 'name',
    filters: ['lifecycle', 'priority', 'eventType'],
  },
  {
    entity: 'location',
    owner: 'tenant',
    supported: true,
    match: 'prefix-indexed',
    ordering: 'name',
    filters: ['type', 'parentId', 'archived'],
  },
  {
    entity: 'event',
    owner: 'events',
    supported: true,
    match: 'filter-only',
    ordering: 'recency',
    filters: ['type', 'cameraId', 'zoneId', 'correlationId', 'from', 'to'],
    limitation:
      'Events are matched structurally. A text index over the event body would index detection payloads, which is both enormous and meaningless to search.',
  },
  {
    entity: 'recording',
    owner: 'media',
    supported: true,
    match: 'filter-only',
    ordering: 'recency',
    filters: ['cameraId', 'from', 'to'],
    limitation: 'A recording has no name — it is identified by its camera and its time range.',
  },
  {
    entity: 'clip',
    owner: 'media',
    supported: true,
    match: 'filter-only',
    ordering: 'recency',
    filters: ['cameraId', 'incidentId', 'status'],
    limitation:
      'Clip labels are not indexed. Adding a text index here is a small, well-scoped future change — it is simply not claimed today.',
  },
  {
    entity: 'operator',
    owner: 'identity',
    supported: false,
    match: 'none',
    ordering: 'name',
    filters: [],
    /*
     * ⚠️ The most consequential row. Operators are directory records: searching them exposes who
     * works for a tenant, which is a different disclosure from "which incidents exist". It needs a
     * permission of its own and an index the Identity context does not have. Declared unsupported
     * rather than shipped with a scan and no permission story.
     */
    limitation:
      'Identity has no indexed principal search, and searching people needs its own permission — directory disclosure is not covered by `incident:read`. Deferred deliberately.',
  },
  {
    entity: 'investigation',
    owner: 'workflow',
    supported: false,
    match: 'none',
    ordering: 'recency',
    filters: [],
    limitation: 'Saved investigations are contract-frozen (P-5.2.0); no store exists yet.',
  },
  {
    entity: 'saved-search',
    owner: 'workflow',
    supported: false,
    match: 'none',
    ordering: 'recency',
    filters: [],
    limitation: 'Saved searches are contract-frozen (P-5.2.0); no store exists yet.',
  },
];

/**
 * Budget for one federated search. ⚠️ Stated in the contract, not buried in a service, because it
 * is the number that decides whether search is a feature or an outage: an unbounded fan-out turns
 * one keystroke into a query against every context the platform owns.
 */
export const SEARCH_MAX_ENTITIES = 5;
export const SEARCH_ENTITY_TIMEOUT_MS = 2_000;
export const SEARCH_MAX_RESULTS_PER_ENTITY = 20;

export const SearchQuery = z.object({
  /** Free text. Interpreted per entity according to its `SearchMatchMode`. */
  text: z.string().min(1).max(200).optional(),
  /**
   * Which entities to search. **Opt-in and capped** at `SEARCH_MAX_ENTITIES` — omitting it does not
   * mean "everything", it means the caller gets the default set, because "everything" is precisely
   * the fan-out the budget exists to prevent.
   */
  entities: z.array(SearchEntityKind).min(1).max(SEARCH_MAX_ENTITIES).optional(),
  /** Inclusive lower bound on each entity's own time field. */
  from: IsoDateTime.optional(),
  /** Exclusive upper bound on the same. */
  to: IsoDateTime.optional(),
  limitPerEntity: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_MAX_RESULTS_PER_ENTITY)
    .default(SEARCH_MAX_RESULTS_PER_ENTITY),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

/**
 * One hit — a **minimal projection**, never the record.
 *
 * A search result carrying whole records would make this contract a second definition of every
 * entity it can return, and would leak fields past the permission that guards the entity's own
 * read. The client follows the id.
 */
export const SearchResultItem = z.object({
  entity: SearchEntityKind,
  id: z.string().min(1),
  title: z.string().min(1).max(300),
  subtitle: z.string().max(300).optional(),
  /** The entity's own timestamp — raised, captured, started. Absent for records without one. */
  at: IsoDateTime.optional(),
  severity: EventPriority.optional(),
  /** For threading a hit back to an investigation. */
  correlationId: z.string().min(1).optional(),
});
export type SearchResultItem = z.infer<typeof SearchResultItem>;

export const SearchResultGroup = z.object({
  entity: SearchEntityKind,
  items: z.array(SearchResultItem).default([]),
  /** How this group was ordered (decision 2). */
  ordering: SearchOrdering,
  /** How the text was matched, so a caller can explain a surprising hit — or a surprising miss. */
  match: SearchMatchMode,
  /**
   * ⚠️ **Absent unless it was free.** A total requires a second, unbounded count query against the
   * same collection; returning an estimate labelled as a count is the kind of number that ends up
   * in a report. Absent means "not counted", never zero.
   */
  total: z.number().int().min(0).optional(),
  /** Present when this entity has more results. Per-entity, because pagination is per-context. */
  nextCursor: z.string().min(1).optional(),
});
export type SearchResultGroup = z.infer<typeof SearchResultGroup>;

/** Why an entity is missing from the results (the §63 pattern, applied to search). */
export const SearchGapReason = z.enum([
  /** The owning context did not answer within `SEARCH_ENTITY_TIMEOUT_MS`, or errored. */
  'unavailable',
  /** The entity declares `supported: false` — see `SEARCH_ENTITIES` for the reason. */
  'unsupported',
  /** The caller lacks the permission that guards this entity. */
  'forbidden',
  /** The caller did not ask for this entity. */
  'not-requested',
  /** The entity answered, but there were more results than the budget allows. */
  'truncated',
]);
export type SearchGapReason = z.infer<typeof SearchGapReason>;

export const SearchGap = z.object({
  entity: SearchEntityKind,
  reason: SearchGapReason,
  detail: z.string().min(1).max(300),
});
export type SearchGap = z.infer<typeof SearchGap>;

/**
 * A federated search result.
 *
 * ⚠️ **`gaps` is not error handling.** An operator searching for a camera that was purged and one
 * searching while the camera service is down see identical empty results unless the second is told.
 * "No results" and "we could not look" are different answers, and only one of them means the thing
 * is not there.
 */
export const SearchResponse = z.object({
  tenantId: TenantId,
  /** Echoed so a cached or shared response is self-describing. */
  query: SearchQuery,
  groups: z.array(SearchResultGroup).default([]),
  gaps: z.array(SearchGap).default([]),
  /** Contexts actually called. Never more than `SEARCH_MAX_ENTITIES`. */
  consulted: z.array(SearchEntityKind).default([]),
  tookMs: z.number().int().min(0),
  derivedAt: IsoDateTime,
});
export type SearchResponse = z.infer<typeof SearchResponse>;

// ---------------------------------------------------------------------------------------------
// P-5.3 rec 10 — facets, reserved.
// ---------------------------------------------------------------------------------------------

/**
 * A dimension results can be narrowed by. **Reserved: nothing computes a facet count today.**
 *
 * ⚠️ **A facet is a promise about an index, not a UI affordance.** Rendering "Camera (14)" beside a
 * search box requires grouping and counting the whole matching set — an aggregation, not a bounded
 * page — and doing that without an index is the collection scan entry criterion G-4 forbids. So the
 * facets are declared, and `SearchFacet.counted` states whether the number is real.
 *
 * The list mirrors the review's: Incident, Rule, Camera, Evidence, Operator, Location, Time and AI
 * Detection. Note that `entity` is not among them — entity *is* the grouping (`SearchResultGroup`),
 * and a facet over it would be a second, weaker spelling of the same thing.
 */
export const SearchFacetKind = z.enum([
  'severity',
  'status',
  'category',
  'camera',
  'location',
  'rule',
  'operator',
  /** Bucketed time — hour, day, week. The bucketing is the server's, stated per facet. */
  'time',
  /** ⚠️ Reserved. Faceting by detection class needs an index the perception path does not have. */
  'ai-detection',
]);
export type SearchFacetKind = z.infer<typeof SearchFacetKind>;

export const SearchFacetValue = z.object({
  value: z.string().min(1).max(200),
  label: z.string().min(1).max(200).optional(),
  /** ⚠️ Absent when `counted` is false — never a placeholder zero. */
  count: z.number().int().min(0).optional(),
});
export type SearchFacetValue = z.infer<typeof SearchFacetValue>;

export const SearchFacet = z.object({
  kind: SearchFacetKind,
  entity: SearchEntityKind,
  /**
   * ⚠️ Whether the counts are real. `false` means the values are offered as filters but the numbers
   * beside them are not computed — which is an honest, useful facet, and a *different* thing from
   * one showing zeroes.
   */
  counted: z.boolean(),
  values: z.array(SearchFacetValue).max(50).default([]),
  /** Required when `counted` is false. */
  limitation: z.string().min(1).max(300).optional(),
});
export type SearchFacet = z.infer<typeof SearchFacet>;
