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
  upload: (
    uploadUrl: string,
    file: File,
    contentType: string,
    onProgress?: (fraction: number, loaded: number, total: number) => void,
  ): Promise<void> =>
    /*
     * ⛔ **`XMLHttpRequest`, not `fetch`, and only because of progress.**
     *
     * `fetch` cannot report upload progress in any shipping browser — the request-stream API is not
     * available, so a `PUT` of a two-gigabyte recording is a single opaque promise. The product
     * declares a **2 GB** ceiling, which on a customer's link is minutes of a spinner that could
     * equally mean "working" or "hung". XHR's `upload.onprogress` is the only way to tell them apart,
     * and being wrong about that is a support call every time.
     *
     * ⚠️ Everything else about the request is unchanged, including the reason it does not go through
     * `http`: the URL is already signed and attaching an `Authorization` header is how a customer's
     * JWT ends up in an object-store access log.
     */
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('content-type', contentType);

      xhr.upload.onprogress = (e) => {
        /* ⚠️ `lengthComputable` is false for a chunked body; reporting 0 % then would look stalled. */
        if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total, e.loaded, e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          /* ⭐ Pinned to 1 on success: the last `progress` event can arrive before the final ack. */
          onProgress?.(1, file.size, file.size);
          resolve();
          return;
        }
        reject(
          new Error(
            `the upload was refused by the object store (${String(xhr.status)}) — the link may have expired`,
          ),
        );
      };
      /* ⛔ Network failure and abort are distinct from a refusal, and say so. */
      xhr.onerror = () =>
        reject(new Error('the upload could not reach the object store — check the connection'));
      xhr.onabort = () => reject(new Error('the upload was cancelled'));
      xhr.send(file);
    }),

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

  /**
   * ⛔ **Cancel a run** — the endpoint has existed since slice 3 and the console never called it.
   *
   * ⚠️ Without this a run stuck in `retrying` **blocks the analysis entirely**: `start` refuses with
   * "already retrying for this analysis — cancel it before starting another", and there was no way
   * to cancel from the product. An operator whose run wedged had no route forward at all.
   */
  cancel: (sessionId: string) =>
    http.post<VideoAnalysisDetail['sessions'][number]>(
      `/media/analysis-sessions/${sessionId}/cancel`,
      {},
    ),
};
