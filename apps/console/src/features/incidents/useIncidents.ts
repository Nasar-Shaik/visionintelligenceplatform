import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AcknowledgeIncidentInput,
  CloseIncidentInput,
  IncidentQuery,
  ResolveIncidentInput,
} from '@vip/contracts';
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

/** Cursor-paginated incident queue ("Load more" via nextCursor). */
export function useIncidentsInfinite(
  params?: Omit<ListParams, 'cursor'>,
  options?: { refetchInterval?: number },
) {
  return useInfiniteQuery({
    queryKey: queryKeys.incidents.list({ ...params, infinite: true }),
    queryFn: ({ pageParam }) =>
      incidentsApi.list({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    ...(options?.refetchInterval ? { refetchInterval: options.refetchInterval } : {}),
  });
}

/** A single incident (detail drawer). Enabled only when an id is selected. */
export function useIncident(id: string | undefined, options?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: queryKeys.incidents.detail(id ?? ''),
    queryFn: () => incidentsApi.get(id as string),
    enabled: Boolean(id),
    ...(options?.refetchInterval ? { refetchInterval: options.refetchInterval } : {}),
  });
}

/** After a transition, refresh both the queue and the detail so status/history stay consistent. */
function useTransition<TInput>(fn: (id: string, input: TInput) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: TInput }) => fn(id, input),
    onSuccess: (_data, { id }) => {
      void qc.invalidateQueries({ queryKey: queryKeys.incidents.all() });
      void qc.invalidateQueries({ queryKey: queryKeys.incidents.detail(id) });
    },
  });
}

export function useAcknowledgeIncident() {
  return useTransition<AcknowledgeIncidentInput>((id, input) =>
    incidentsApi.acknowledge(id, input),
  );
}

export function useResolveIncident() {
  return useTransition<ResolveIncidentInput>((id, input) => incidentsApi.resolve(id, input));
}

export function useCloseIncident() {
  return useTransition<CloseIncidentInput>((id, input) => incidentsApi.close(id, input));
}
