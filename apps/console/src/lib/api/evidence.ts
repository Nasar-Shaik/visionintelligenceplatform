import type {
  Evidence,
  EvidenceCustodyPage,
  EvidenceDownloadTarget,
  EvidencePage,
  EvidenceQuery,
  PlaybackSession,
} from '@vip/contracts';
import { http } from './http';

/**
 * ⚠️ Every filter here is index-backed (`services/evidence/src/adapters/indexes.ts`, proven by that
 * service's coverage test — P-5.1 closed TD-25). A client-side filter with no index is how a panel
 * becomes a collection scan (CONSTRAINTS §40).
 */
type ListParams = Partial<
  Pick<
    EvidenceQuery,
    | 'kind'
    | 'status'
    | 'cameraId'
    | 'incidentId'
    | 'eventId'
    | 'correlationId'
    | 'from'
    | 'to'
    | 'limit'
    | 'cursor'
  >
>;

/**
 * Evidence reads (through the gateway: `/api/evidence/*`).
 *
 * ⚠️ **There is no update or delete here, and that is the contract, not an omission.** Evidence is
 * immutable; an investigator's statement *about* evidence is an incident note referencing it by id
 * (CONTEXT_OWNERSHIP line 1). The only mutation the Evidence context accepts is a sidecar metadata
 * patch and a retention change, neither of which the workspace performs.
 */
export const evidenceApi = {
  list: (params?: ListParams) =>
    http.get<EvidencePage>('/evidence/evidence', params ? { query: params } : undefined),
  get: (id: string) => http.get<Evidence>(`/evidence/evidence/${id}`),
  /**
   * A short-lived signed target. ⚠️ **Requested per view, never cached** — the URL expires, and a
   * stored one is a broken link at best. Issuing one is an audited access, and `reason` is carried
   * into the custody log.
   */
  download: (id: string, reason?: string) =>
    http.get<EvidenceDownloadTarget>(
      `/evidence/evidence/${id}/download`,
      reason !== undefined ? { query: { reason } } : undefined,
    ),
  /** The hash-chained custody log — the artefact that makes the integrity hash mean something. */
  custody: (id: string) => http.get<EvidenceCustodyPage>(`/evidence/evidence/${id}/custody`),
  /**
   * Resolve a playback session (P-5.5).
   *
   * ⚠️ **Derived per request and never cached beyond its expiry.** The session carries signed
   * segment URLs that die on their own schedule; a cached session is a player that silently stops
   * working. `staleTime` on this key is deliberately shorter than the shortest segment TTL.
   *
   * ⚠️ Resolving one is an **audited access** — it appears in the item's chain of custody as
   * `via: 'playback'`. That is the intended behaviour, not a side effect: an investigator reviewing
   * a clip a hundred times should not leave a custody log that says nobody opened it.
   */
  playback: (id: string, reason?: string) =>
    http.get<PlaybackSession>(
      `/evidence/evidence/${id}/playback`,
      reason !== undefined ? { query: { reason } } : undefined,
    ),
};
