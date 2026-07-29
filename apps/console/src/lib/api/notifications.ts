import type { NotificationPage, NotificationQuery } from '@vip/contracts';
import { http } from './http';

type ListParams = Partial<Pick<NotificationQuery, 'incidentId' | 'status' | 'limit' | 'cursor'>>;

/** Alert delivery-log reads (through the gateway: `/api/notify/*`). Ack lands in P2-1.11. */
export const notificationsApi = {
  list: (params?: ListParams) =>
    http.get<NotificationPage>('/notify/notifications', params ? { query: params } : undefined),
};
