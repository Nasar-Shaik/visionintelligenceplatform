import { useQuery } from '@tanstack/react-query';
import type { NotificationQuery } from '@vip/contracts';
import { notificationsApi } from '@/lib/api/notifications';
import { queryKeys } from '@/lib/queryKeys';

type ListParams = Partial<Pick<NotificationQuery, 'incidentId' | 'status' | 'limit' | 'cursor'>>;

/** Alert delivery-log list (server state). */
export function useNotifications(params?: ListParams, options?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: queryKeys.notifications.list(params),
    queryFn: () => notificationsApi.list(params),
    ...(options?.refetchInterval ? { refetchInterval: options.refetchInterval } : {}),
  });
}
