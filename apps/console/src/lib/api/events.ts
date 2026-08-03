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
    'type' | 'cameraId' | 'zoneId' | 'correlationId' | 'from' | 'to' | 'limit' | 'cursor'
  >
>;

/** Event store reads (through the gateway: `/api/events/*`). Note: page uses `events`, not `items`. */
export const eventsApi = {
  list: (params?: ListParams) =>
    http.get<EventPage>('/events/events', params ? { query: params } : undefined),
};
