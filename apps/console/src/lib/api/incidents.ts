import type {
  AcknowledgeIncidentInput,
  EvidenceChain,
  AddIncidentNoteInput,
  AssignIncidentInput,
  CloseIncidentInput,
  EscalateIncidentInput,
  Incident,
  IncidentActivity,
  IncidentPage,
  IncidentQuery,
  IncidentSlaStatus,
  IncidentTimeline,
  InvestigateIncidentInput,
  ResolveIncidentInput,
  CreatePlaybackBookmarkInput,
  PlaybackBookmark,
} from '@vip/contracts';
import { http } from './http';

type ListParams = Partial<
  Pick<
    IncidentQuery,
    | 'status'
    | 'severity'
    | 'category'
    | 'eventType'
    | 'cameraId'
    | 'zoneId'
    | 'ruleId'
    | 'correlationId'
    | 'assignee'
    | 'from'
    | 'to'
    | 'limit'
    | 'cursor'
  >
>;

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

  /** One document read, no fan-out — the header's narrative (P-5.0). */
  activity: (id: string) => http.get<IncidentActivity>(`/workflow/incidents/${id}/activity`),

  /**
   * The cross-context narrative (P-5.1 F-3, joins wired in P-5.2).
   *
   * ⚠️ `include` is **opt-in per source** because each one costs an upstream call against a
   * three-call budget. A source that is not asked for comes back as a `not-requested` gap, so the
   * panel can always tell "there is nothing" from "nobody asked".
   */
  timeline: (id: string, include: readonly string[] = []) =>
    http.get<IncidentTimeline>(
      `/workflow/incidents/${id}/timeline`,
      include.length > 0 ? { query: { include: include.join(',') } } : undefined,
    ),

  /** ⚠️ Returns `state: 'unknown'` when the deployment configured no policy — never `met`. */
  sla: (id: string) => http.get<IncidentSlaStatus>(`/workflow/incidents/${id}/sla`),

  /**
   * The evidence chain (P-5.3) — camera → detection → rule → incident → evidence → playback →
   * export → report. ⚠️ Unresolved stages carry **which of six reasons** applies, so a customer
   * never reads a broken link as lost data.
   */
  chain: (id: string) => http.get<EvidenceChain>(`/workflow/incidents/${id}/chain`),

  acknowledge: (id: string, input: AcknowledgeIncidentInput = {}) =>
    http.post<Incident>(`/workflow/incidents/${id}/ack`, input),
  investigate: (id: string, input: InvestigateIncidentInput = {}) =>
    http.post<Incident>(`/workflow/incidents/${id}/investigate`, input),
  escalate: (id: string, input: EscalateIncidentInput = {}) =>
    http.post<Incident>(`/workflow/incidents/${id}/escalate`, input),
  resolve: (id: string, input: ResolveIncidentInput = {}) =>
    http.post<Incident>(`/workflow/incidents/${id}/resolve`, input),
  close: (id: string, input: CloseIncidentInput = {}) =>
    http.post<Incident>(`/workflow/incidents/${id}/close`, input),
  /** `assignee: null` un-assigns — a real operator action that has to be expressible. */
  assign: (id: string, input: AssignIncidentInput) =>
    http.post<Incident>(`/workflow/incidents/${id}/assign`, input),
  addNote: (id: string, input: AddIncidentNoteInput) =>
    http.post<Incident>(`/workflow/incidents/${id}/notes`, input),

  // --- investigation bookmarks (P-5.5) ------------------------------------------------------
  /**
   * ⚠️ Bookmarks live in the **Workflow** context, not Evidence — a bookmark is a statement an
   * investigator made about evidence, so it belongs to the investigation and references the
   * evidence by id (CONTEXT_OWNERSHIP; CONSTRAINTS §60).
   */
  bookmarks: (id: string) =>
    http.get<{ items: PlaybackBookmark[]; nextCursor?: string }>(
      `/workflow/incidents/${id}/bookmarks`,
    ),
  addBookmark: (id: string, body: CreatePlaybackBookmarkInput) =>
    http.post<PlaybackBookmark>(`/workflow/incidents/${id}/bookmarks`, body),
  removeBookmark: (id: string, bookmarkId: string) =>
    http.del<void>(`/workflow/incidents/${id}/bookmarks/${bookmarkId}`),
};
