import type { EventPage, EventQuery } from '@vip/contracts';
import { http } from './http';

/**
 * ⚠️ `correlationId` is included because it is **index-backed** — `tenant_correlation_time` in
 * `services/events/src/adapters/indexes.ts`, proven by that service's coverage test. Every filter
 * exposed here has one (CONSTRAINTS §40); a client-side filter with no index is how a workspace
 * panel becomes a collection scan.
 */
type ListParams = Partial<
  Pick<
    EventQuery,
    | 'type'
    | 'cameraId'
    | 'zoneId'
    | 'correlationId'
    /**
     * ⭐ **One analysis run's events** (P-8.6). Index-backed by `tenant_analysisSession_time`, and
     * sparse in effect — live events carry no `analysisSessionId`, so they occupy no entry.
     *
     * ⛔ **`includeAnalyses` is deliberately NOT exposed here.** It removes the offline exclusion
     * from an otherwise live read, which is both an unindexed shape and the exact mixing ADR-0047
     * exists to prevent: an investigation of last month's footage must never land in the queue an
     * operator is being dispatched from. Naming a run is precise; widening the live feed is not.
     */
    | 'analysisSessionId'
    | 'from'
    | 'to'
    | 'limit'
    | 'cursor'
  >
>;

/** Event store reads (through the gateway: `/api/events/*`). Note: page uses `events`, not `items`. */
export const eventsApi = {
  list: (params?: ListParams) =>
    http.get<EventPage>('/events/events', params ? { query: params } : undefined),
};
