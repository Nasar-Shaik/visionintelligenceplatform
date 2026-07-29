import { useQuery } from '@tanstack/react-query';
import type { EventQuery } from '@vip/contracts';
import { eventsApi } from '@/lib/api/events';
import { queryKeys } from '@/lib/queryKeys';

type ListParams = Partial<
  Pick<EventQuery, 'type' | 'cameraId' | 'zoneId' | 'from' | 'to' | 'limit' | 'cursor'>
>;

/** Event store list (server state). */
export function useEvents(params?: ListParams, options?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: queryKeys.events.list(params),
    queryFn: () => eventsApi.list(params),
    ...(options?.refetchInterval ? { refetchInterval: options.refetchInterval } : {}),
  });
}
