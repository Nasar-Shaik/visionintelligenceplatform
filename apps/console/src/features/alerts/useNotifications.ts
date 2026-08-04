import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AckNotificationInput, NotificationQuery } from '@vip/contracts';
import { notificationsApi } from '@/lib/api/notifications';
import { queryKeys } from '@/lib/queryKeys';

type ListParams = Partial<
  Pick<NotificationQuery, 'incidentId' | 'status' | 'acknowledged' | 'limit' | 'cursor'>
>;

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

/**
 * How many incidents are waiting for somebody — the number on the bell in the top bar.
 *
 * ### ⚠️ Incidents, not deliveries
 *
 * One incident that fanned out to three channels is **one** thing waiting. Counting delivery records
 * would show "3" for a single alert and make the badge meaningless within a day of a customer wiring
 * up a second channel.
 *
 * ### ⚠️ The cap is honest
 *
 * One page is fetched, not the whole queue: a badge is not worth an unbounded read. When there is a
 * further page the count is reported as capped (`50+` rather than `50`), because a number that
 * silently stops rising is worse than one that admits where it stopped.
 *
 * `acknowledged: false` does the filtering **server-side**; counting client-side over "everything
 * loaded" is how an unread badge starts lying.
 */
export function useInboxCount(options?: { refetchInterval?: number }) {
  const query = useQuery({
    queryKey: queryKeys.notifications.list({ waiting: true }),
    queryFn: () => notificationsApi.list({ acknowledged: false, limit: 50 }),
    ...(options?.refetchInterval ? { refetchInterval: options.refetchInterval } : {}),
  });
  const items = query.data?.items ?? [];
  return {
    /** Distinct incidents with at least one unacknowledged delivery. */
    count: new Set(items.map((n) => n.incidentId)).size,
    /** True when a further page exists, so the count is a floor rather than a total. */
    capped: query.data?.nextCursor !== undefined,
    isPending: query.isPending,
    isError: query.isError,
  };
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
