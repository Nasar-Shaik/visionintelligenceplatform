import { useQuery } from '@tanstack/react-query';
import type { IncidentQuery } from '@vip/contracts';
import { incidentsApi } from '@/lib/api/incidents';
import { queryKeys } from '@/lib/queryKeys';

type ListParams = Partial<Pick<IncidentQuery, 'status' | 'severity' | 'limit' | 'cursor'>>;

/** Incident list (server state). */
export function useIncidents(params?: ListParams, options?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: queryKeys.incidents.list(params),
    queryFn: () => incidentsApi.list(params),
    ...(options?.refetchInterval ? { refetchInterval: options.refetchInterval } : {}),
  });
}
