import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AckNotificationInput, NotificationQuery } from '@vip/contracts';
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

/** Cursor-paginated delivery log ("Load more" via nextCursor). */
export function useNotificationsInfinite(
  params?: Omit<ListParams, 'cursor'>,
  options?: { refetchInterval?: number },
) {
  return useInfiniteQuery({
    queryKey: queryKeys.notifications.list({ ...params, infinite: true }),
    queryFn: ({ pageParam }) =>
      notificationsApi.list({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    ...(options?.refetchInterval ? { refetchInterval: options.refetchInterval } : {}),
  });
}

/** Acknowledge a delivered notification (with-ack completion). Refreshes the delivery log. */
export function useAckNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input?: AckNotificationInput }) =>
      notificationsApi.ack(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.notifications.all() }),
  });
}
