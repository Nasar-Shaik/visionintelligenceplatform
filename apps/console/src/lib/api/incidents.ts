import type {
  AcknowledgeIncidentInput,
  CloseIncidentInput,
  Incident,
  IncidentPage,
  IncidentQuery,
  ResolveIncidentInput,
} from '@vip/contracts';
import { http } from './http';

type ListParams = Partial<Pick<IncidentQuery, 'status' | 'severity' | 'limit' | 'cursor'>>;

/**
 * Incident reads + operator lifecycle transitions (through the gateway: `/api/workflow/*`).
 * Incidents are never created via the API — they are promoted from `incident.candidate` by the
 * workflow consumer. Transitions are permission-gated server-side (incident:ack / incident:resolve)
 * and an illegal move (e.g. closing a `raised` incident) is a 409.
 */
export const incidentsApi = {
  list: (params?: ListParams) =>
    http.get<IncidentPage>('/workflow/incidents', params ? { query: params } : undefined),
  get: (id: string) => http.get<Incident>(`/workflow/incidents/${id}`),
  acknowledge: (id: string, input: AcknowledgeIncidentInput = {}) =>
    http.post<Incident>(`/workflow/incidents/${id}/ack`, input),
  resolve: (id: string, input: ResolveIncidentInput = {}) =>
    http.post<Incident>(`/workflow/incidents/${id}/resolve`, input),
  close: (id: string, input: CloseIncidentInput = {}) =>
    http.post<Incident>(`/workflow/incidents/${id}/close`, input),
};
