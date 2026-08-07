import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { investigationsApi } from '@/lib/api/investigations';

/** Query keys for offline video investigation. Kept local — nothing else reads these. */
const keys = {
  list: (params?: unknown) => ['investigations', 'list', params ?? {}] as const,
  detail: (id: string) => ['investigations', 'detail', id] as const,
  timeline: (id: string, sessionId?: string) =>
    ['investigations', 'timeline', id, sessionId ?? 'latest'] as const,
  report: (id: string, sessionId?: string) =>
    ['investigations', 'report', id, sessionId ?? 'latest'] as const,
  playback: (id: string) => ['investigations', 'playback', id] as const,
};

export function useInvestigations(params?: { cameraId?: string; limit?: number }) {
  return useQuery({
    queryKey: keys.list(params),
    queryFn: () => investigationsApi.list(params),
  });
}

/**
 * One analysis and its runs.
 *
 * ⭐ **Polls while a run is in flight, and stops when it is not.** A session moves through nine
 * states over minutes; a static page would leave an operator watching a "queued" badge that finished
 * ten minutes ago. ⚠️ Polling *only* while non-terminal — an idle investigations tab must not keep
 * asking a question whose answer cannot change.
 */
export function useInvestigation(id: string) {
  return useQuery({
    queryKey: keys.detail(id),
    queryFn: () => investigationsApi.detail(id),
    refetchInterval: (query) => {
      const sessions = query.state.data?.sessions ?? [];
      const running = sessions.some(
        (s) => !['succeeded', 'failed', 'cancelled', 'expired'].includes(s.state),
      );
      return running ? 2_000 : false;
    },
  });
}

export function useTimeline(id: string, sessionId?: string, enabled = true) {
  return useQuery({
    queryKey: keys.timeline(id, sessionId),
    queryFn: () => investigationsApi.timeline(id, sessionId),
    enabled,
    /* ⚠️ A timeline of a finished run never changes; retrying a 409 would just re-ask. */
    retry: false,
  });
}

export function useReport(id: string, sessionId?: string, enabled = false) {
  return useQuery({
    queryKey: keys.report(id, sessionId),
    queryFn: () => investigationsApi.report(id, sessionId),
    enabled,
    retry: false,
  });
}

/**
 * A signed URL for the recording itself (P-8.6).
 *
 * ⛔ **The URL expires, and a `<video>` that is handed an expired one fails silently** — the element
 * fires `error` and shows a black rectangle, which an operator reads as "the video is broken", not
 * as "the link aged out". So the URL is refetched a minute before `expiresAt`, and the player
 * preserves its position across the swap.
 *
 * ⚠️ `staleTime: 0` deliberately: a cached URL from twenty minutes ago is worse than no URL, because
 * it looks valid right up until the browser tries to use it.
 */
export function usePlayback(id: string, enabled = true) {
  return useQuery({
    queryKey: keys.playback(id),
    queryFn: () => investigationsApi.playback(id),
    enabled,
    staleTime: 0,
    refetchInterval: (query) => {
      const expiresAt = query.state.data?.expiresAt;
      if (expiresAt === undefined) return false;
      const msLeft = Date.parse(expiresAt) - Date.now();
      /* ⚠️ Floor of 30 s so a clock skew that puts expiry in the past cannot spin the query. */
      return Math.max(30_000, msLeft - 60_000);
    },
  });
}

/**
 * ⭐ **Upload is three steps and the UI must show which one it is on.**
 *
 * Create (claim a slot) → PUT the bytes straight to the object store → confirm (the platform probes
 * what actually landed). ⚠️ A single "uploading…" spinner across all three is why a customer cannot
 * tell a rejected codec from a slow network, so the caller is told each stage as it starts.
 */
export function useUploadInvestigation(
  onStage?: (stage: 'creating' | 'uploading' | 'confirming') => void,
  /** ⭐ Real bytes on the wire, `[0,1]` — see the XHR note in `lib/api/investigations.ts`. */
  onProgress?: (fraction: number, loaded: number, total: number) => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      file: File;
      cameraId: string;
      label?: string;
      footageStartedAt?: string;
    }) => {
      onStage?.('creating');
      const created = await investigationsApi.create({
        cameraId: input.cameraId,
        ...(input.label === undefined ? {} : { label: input.label }),
        originalName: input.file.name,
        /* ⚠️ The browser's guess, and it is only a claim — `confirm` measures what really landed. */
        contentType: input.file.type || 'video/mp4',
        bytes: input.file.size,
        ...(input.footageStartedAt === undefined ? {} : { footageStartedAt: input.footageStartedAt }),
      });
      onStage?.('uploading');
      await investigationsApi.upload(
        created.uploadUrl,
        input.file,
        created.contentType,
        onProgress,
      );
      onStage?.('confirming');
      await investigationsApi.confirm(created.analysis.id);
      return created.analysis;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['investigations', 'list'] }),
  });
}

export function useStartRun(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { speed?: number | null } = {}) =>
      investigationsApi.start(id, input.speed === undefined ? {} : { speed: input.speed }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.detail(id) }),
  });
}

/** ⭐ Cancel a run. Invalidates the detail so the row's state moves without a manual refresh. */
export function useCancelRun(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => investigationsApi.cancel(sessionId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.detail(id) }),
  });
}

export function useSnapshot(id: string) {
  return useMutation({
    mutationFn: (input: { offsetSeconds: number; incidentId?: string }) =>
      investigationsApi.snapshot(id, input),
  });
}
