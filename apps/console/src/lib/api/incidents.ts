import type { Incident, IncidentPage, IncidentQuery } from '@vip/contracts';
import { http } from './http';

type ListParams = Partial<Pick<IncidentQuery, 'status' | 'severity' | 'limit' | 'cursor'>>;

/** Incident reads (through the gateway: `/api/workflow/*`). Transitions land in P2-1.10. */
export const incidentsApi = {
  list: (params?: ListParams) =>
    http.get<IncidentPage>('/workflow/incidents', params ? { query: params } : undefined),
  get: (id: string) => http.get<Incident>(`/workflow/incidents/${id}`),
};
