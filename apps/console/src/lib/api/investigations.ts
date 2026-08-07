import type {
  AnalysisReport,
  AnalysisSnapshot,
  AnalysisSnapshotInput,
  AnalysisTimeline,
  StartAnalysisSessionInput,
  VideoAnalysisDetail,
  VideoAnalysisPage,
  VideoAnalysisPlayback,
  VideoAnalysisUpload,
} from '@vip/contracts';
import { http } from './http';

/**
 * Offline video investigation (through the gateway: `/api/media/analyses/*`).
 *
 * ⭐ **The upload does not go through here.** `createUpload` returns a **presigned PUT** and the
 * browser writes the bytes straight to the object store — a multi-gigabyte multipart POST through the
 * edge and the gateway would buffer a customer's video in three processes and hold a JWT-authorised
 * connection open for a quarter of an hour. ADR-0036 decided the browser may talk to the store, and
 * the edge serves it same-origin, so there is no CORS and no second origin.
 */
export const investigationsApi = {
  list: (params?: { cameraId?: string; limit?: number; cursor?: string }) =>
    http.get<VideoAnalysisPage>('/media/analyses', params ? { query: params } : undefined),

  detail: (id: string) => http.get<VideoAnalysisDetail>(`/media/analyses/${id}`),

  create: (input: {
    cameraId: string;
    label?: string;
    originalName: string;
    contentType: string;
    bytes: number;
    footageStartedAt?: string;
  }) => http.post<VideoAnalysisUpload>('/media/analyses', input),

  /**
   * ⚠️ Straight to the object store, **not** through `http`: no `Authorization` header must be
   * attached. The URL is already signed, and adding a bearer token to a presigned request is how a
   * customer's JWT ends up in an object-store access log.
   */
  upload: async (uploadUrl: string, file: File, contentType: string): Promise<void> => {
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: file,
    });
    if (!res.ok) {
      throw new Error(
        `the upload was refused by the object store (${String(res.status)}) — the link may have expired`,
      );
    }
  },

  confirm: (id: string, input: { footageStartedAt?: string } = {}) =>
    http.post<VideoAnalysisDetail['analysis']>(`/media/analyses/${id}/confirm`, input),

  start: (id: string, input: StartAnalysisSessionInput = {}) =>
    http.post<VideoAnalysisDetail['sessions'][number]>(`/media/analyses/${id}/sessions`, input),

  /** ⚠️ Omitting `sessionId` means the LATEST run, never a merge of all runs (ADR-0047). */
  timeline: (id: string, sessionId?: string) =>
    http.get<AnalysisTimeline>(
      `/media/analyses/${id}/timeline`,
      sessionId === undefined ? undefined : { query: { sessionId } },
    ),

  report: (id: string, sessionId?: string) =>
    http.get<AnalysisReport>(
      `/media/analyses/${id}/report`,
      sessionId === undefined ? undefined : { query: { sessionId } },
    ),

  snapshot: (id: string, input: AnalysisSnapshotInput) =>
    http.post<AnalysisSnapshot>(`/media/analyses/${id}/snapshots`, input),

  playback: (id: string) => http.get<VideoAnalysisPlayback>(`/media/analyses/${id}/playback`),
};
