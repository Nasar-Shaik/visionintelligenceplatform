import type {
  AckNotificationInput,
  Notification,
  NotificationPage,
  NotificationQuery,
} from '@vip/contracts';
import { http } from './http';

type ListParams = Partial<Pick<NotificationQuery, 'incidentId' | 'status' | 'limit' | 'cursor'>>;

/**
 * Alert delivery-log reads + recipient ack (through the gateway: `/api/notify/*`). Notifications are
 * never created via the API — the Alert Engine emits one per channel per `incident.raised`. `ack` is
 * the with-ack completion of the vertical (permission-gated `notification:ack` server-side).
 */
export const notificationsApi = {
  list: (params?: ListParams) =>
    http.get<NotificationPage>('/notify/notifications', params ? { query: params } : undefined),
  get: (id: string) => http.get<Notification>(`/notify/notifications/${id}`),
  ack: (id: string, input: AckNotificationInput = {}) =>
    http.post<Notification>(`/notify/notifications/${id}/ack`, input),
};
