/**
 * Application ports — the persistence seam for incidents, so the promotion + transition logic is
 * testable without Mongo. `IncidentStore` is intentionally thin (get/insert/replace/list + a
 * dedup-key lookup); all lifecycle logic lives in the domain factory + `IncidentService`, shared by
 * every adapter. Reads/writes are tenant-scoped structurally (via @vip/tenancy).
 */
import type { Incident, IncidentPage, IncidentQuery } from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import type {
  RelatedAutomation,
  RelatedEvent,
  RelatedEvidence,
} from '../domain/incident-timeline.js';

export interface IncidentStore {
  /** Insert a freshly promoted incident. Throws a 409 `AppError` on a duplicate (tenant,id|dedupKey). */
  insert(scope: TenantScope, incident: Incident): Promise<void>;
  get(scope: TenantScope, id: string): Promise<Incident | null>;
  /** Look up an existing incident by its source dedup key (idempotent promotion). */
  getByDedupKey(scope: TenantScope, dedupKey: string): Promise<Incident | null>;
  list(scope: TenantScope, query: IncidentQuery): Promise<IncidentPage>;
  /**
   * Persist a transitioned incident, guarded by the previous version (optimistic concurrency).
   * Returns false if no row matched (id missing or version moved) — the caller retries/uses 409.
   */
  replace(scope: TenantScope, incident: Incident, expectedVersion: number): Promise<boolean>;
}

/**
 * The upstream reads the timeline joins (P-5.1, F-3).
 *
 * ⚠️ **Each defaults to unavailable, deliberately.** The same pattern P-4 used for the location
 * hierarchy: a cross-context dependency that is not wired must degrade to a *named gap*, never to
 * an empty list that reads as "nothing happened". `UnavailableTimelineSources` below is the default
 * wiring, and it is what a deployment without these services configured actually gets.
 *
 * Every method is **bounded** — it takes a limit and returns whether more existed. One call per
 * source per timeline read; never one per entry (CONSTRAINTS §54).
 */
export interface TimelineSources {
  /** Events on the incident's correlation spine, newest first, bounded. */
  relatedEvents(
    scope: TenantScope,
    correlationId: string,
    limit: number,
  ): Promise<{ items: RelatedEvent[]; truncated: boolean }>;
  /** Evidence registered against this incident or its correlation, bounded. */
  relatedEvidence(
    scope: TenantScope,
    incidentId: string,
    correlationId: string,
    limit: number,
  ): Promise<{ items: RelatedEvidence[]; truncated: boolean }>;
  /** Notifications this incident produced, bounded. */
  relatedAutomation(
    scope: TenantScope,
    incidentId: string,
    limit: number,
  ): Promise<{ items: RelatedAutomation[]; truncated: boolean }>;
}

/**
 * The default: every source unavailable, with a reason a reader can act on.
 *
 * Throwing rather than returning empty is the point — the application turns a throw into a
 * `gap: { reason: 'unavailable' }`, and an empty list would instead claim the source was consulted
 * and had nothing.
 */
export const UnavailableTimelineSources: TimelineSources = {
  relatedEvents() {
    return Promise.reject(new Error('the events context is not configured for this deployment'));
  },
  relatedEvidence() {
    return Promise.reject(new Error('the evidence context is not configured for this deployment'));
  },
  relatedAutomation() {
    return Promise.reject(new Error('the notify context is not configured for this deployment'));
  },
};
