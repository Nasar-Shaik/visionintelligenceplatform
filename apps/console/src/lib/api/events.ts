import type { EventPage, EventQuery } from '@vip/contracts';
import { http } from './http';

type ListParams = Partial<
  Pick<EventQuery, 'type' | 'cameraId' | 'zoneId' | 'from' | 'to' | 'limit' | 'cursor'>
>;

/** Event store reads (through the gateway: `/api/events/*`). Note: page uses `events`, not `items`. */
export const eventsApi = {
  list: (params?: ListParams) =>
    http.get<EventPage>('/events/events', params ? { query: params } : undefined),
};
