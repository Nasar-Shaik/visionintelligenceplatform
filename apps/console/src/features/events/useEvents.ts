import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { EventQuery } from '@vip/contracts';
import { eventsApi } from '@/lib/api/events';
import { queryKeys } from '@/lib/queryKeys';

type ListParams = Partial<
  Pick<
    EventQuery,
    /* ⭐ `analysisSessionId` added in P-8.6 — see the note in `lib/api/events.ts` for why
     * `includeAnalyses` is not here. */
    'type' | 'cameraId' | 'zoneId' | 'analysisSessionId' | 'from' | 'to' | 'limit' | 'cursor'
  >
>;

/** Single-page event list (server state). */
export function useEvents(params?: ListParams, options?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: queryKeys.events.list(params),
    queryFn: () => eventsApi.list(params),
    ...(options?.refetchInterval ? { refetchInterval: options.refetchInterval } : {}),
  });
}

/** Cursor-paginated event list for the Events timeline ("Load more" via nextCursor). */
export function useEventsInfinite(params?: Omit<ListParams, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.events.list({ ...params, infinite: true }),
    queryFn: ({ pageParam }) =>
      eventsApi.list({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}
