import { useCallback } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateCameraInput,
  DiscoverCamerasInput,
  HealthTrendWindow,
  UpdateCameraInput,
} from '@vip/contracts';
import { camerasApi, type CameraListQuery } from '@/lib/api/cameras';
import { mediaApi } from '@/lib/api/media';
import { ApiRequestError } from '@/lib/api/http';
import { queryKeys } from '@/lib/queryKeys';

/**
 * One page of the camera registry (server state). `refetchInterval` enables dashboard polling.
 *
 * ⚠️ **A page, not the estate.** This used to fetch every camera a tenant owns and let the browser
 * search, filter and count them — which is correct at nine cameras and a different product at five
 * thousand. Callers that need a fleet-wide number ask the server for one (`useFleetMetrics`).
 */
export function useCameras(query: CameraListQuery = {}, options?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: queryKeys.cameras.list(query as Record<string, unknown>),
    queryFn: () => camerasApi.list(query),
    ...(options?.refetchInterval ? { refetchInterval: options.refetchInterval } : {}),
  });
}

/**
 * The camera list as an operator pages through it — server-filtered, server-searched, keyset-paged.
 *
 * ⚠️ Bounded at `MAX_PAGES`, for the reason P-6.5 measured on the Inbox: an infinite query refetches
 * **every page it has loaded** on each poll, so an unbounded list quietly costs more the longer it
 * is left open. The page that uses this says on screen when the bound bites.
 */
export function useCameraPages(query: Omit<CameraListQuery, 'cursor'> = {}) {
  return useInfiniteQuery({
    queryKey: queryKeys.cameras.list({ ...query, paged: true } as Record<string, unknown>),
    queryFn: ({ pageParam }) =>
      camerasApi.list({ ...query, ...(pageParam ? { cursor: pageParam as string } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 10_000,
  });
}

/**
 * The estate's own numbers, computed by the server (P-6.6).
 *
 * ⚠️ Carries `sampled`, and the UI must show it: an aggregate over a bounded sample presented as a
 * census is a confident number describing a subset nobody chose.
 */
export function useFleetMetrics(window: HealthTrendWindow = 'day') {
  return useQuery({
    queryKey: queryKeys.cameras.fleet(window),
    queryFn: () => camerasApi.fleetMetrics(window),
    staleTime: 30_000,
  });
}

/** Health over time for one camera — the trend behind the current status. */
export function useCameraHealthSummary(id: string | undefined, window: HealthTrendWindow = 'day') {
  return useQuery({
    queryKey: queryKeys.cameras.healthSummary(id ?? '', window),
    queryFn: () => camerasApi.healthSummary(id as string, window),
    enabled: Boolean(id),
  });
}

/** Probe success/latency aggregates for one camera. */
export function useProbeMetrics(id: string | undefined, window: HealthTrendWindow = 'day') {
  return useQuery({
    queryKey: queryKeys.cameras.probeMetrics(id ?? '', window),
    queryFn: () => camerasApi.probeMetrics(id as string, window),
    enabled: Boolean(id),
  });
}

/** How confident the platform is in what it believes about this camera, over time. */
export function useConfidenceTrend(id: string | undefined, window: HealthTrendWindow = 'month') {
  return useQuery({
    queryKey: queryKeys.cameras.confidence(id ?? '', window),
    queryFn: () => camerasApi.confidenceTrend(id as string, window),
    enabled: Boolean(id),
  });
}

/**
 * Resolve a camera id to the name an operator recognises.
 *
 * ### ⚠️ Why this is a display-layer join and not a contract change
 *
 * Incidents and events store `cameraId`, and that is correct: an id is stable and a name is
 * editable, so denormalising the name into an incident would freeze whatever the camera was called
 * on the day it fired. The name belongs to the camera registry and is resolved when it is shown.
 *
 * ### ⚠️ What it fixes
 *
 * Found in P-5.9 by loading a realistic estate: the incident queue and the dashboard rendered
 * **raw database ids** — `cam_retail_electronics2` — in the column headed CAMERA, on the two
 * screens a security manager lives in. It was invisible for five milestones because the only
 * seeded camera was `cam_dev_1`, and an id that short reads like a name.
 *
 * Falls back to the id when the camera is unknown: a decommissioned camera still has incidents, and
 * showing its id is honest where inventing a name would not be.
 */
export function useCameraName(): (cameraId: string | undefined) => string | undefined {
  /*
   * ⚠️ **Bounded, and it says so in a limitation rather than in silence.**
   *
   * This is a display join for screens that store `cameraId` — the incident queue, events, the
   * dashboard. It reads one page of names (not the estate) with a long staleTime, because names
   * change rarely and this hook is mounted on nearly every screen. Beyond `NAME_MAP_LIMIT` cameras
   * an unresolved id renders **as the id**, which is what it did before any of this existed and is
   * honest; the fix is a batch resolve endpoint, which the camera API does not have today.
   */
  const { data } = useQuery({
    queryKey: queryKeys.cameras.names(),
    queryFn: () => camerasApi.list({ limit: NAME_MAP_LIMIT }),
    staleTime: 5 * 60_000,
  });
  return useCallback(
    (cameraId: string | undefined): string | undefined => {
      if (cameraId === undefined) return undefined;
      return data?.cameras.find((camera) => camera.id === cameraId)?.name ?? cameraId;
    },
    [data],
  );
}

/** How many camera names the display join holds. See `useCameraName`. */
export const NAME_MAP_LIMIT = 200;

/** One camera by id. */
export function useCamera(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.cameras.detail(id ?? ''),
    queryFn: () => camerasApi.get(id as string),
    enabled: Boolean(id),
  });
}

export function useCreateCamera() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCameraInput) => camerasApi.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.cameras.all() }),
  });
}

/**
 * Edit a camera.
 *
 * ⚠️ `expectedUpdatedAt` is the `updatedAt` of the record the operator was looking at. Without it the
 * server cannot tell an edit from an overwrite — measured at P-6.6: two administrators saving at the
 * same moment both got HTTP 200 and one edit vanished. With it, the loser gets a 409 naming when the
 * record changed underneath them.
 */
export function useUpdateCamera(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      patch,
      expectedUpdatedAt,
    }: {
      patch: UpdateCameraInput;
      expectedUpdatedAt?: string;
    }) => camerasApi.update(id, patch, expectedUpdatedAt),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.cameras.all() }),
  });
}

export function useDeleteCamera() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => camerasApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.cameras.all() }),
  });
}

export function useSetCameraStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'enabled' | 'disabled' }) =>
      camerasApi.setStatus(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.cameras.all() }),
  });
}

export function useCheckCameraHealth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => camerasApi.checkHealth(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.cameras.all() }),
  });
}

/**
 * Network discovery (P-1).
 *
 * A **mutation, not a query**, despite returning a list: a probe is an active multicast operation
 * against the customer's network with a multi-second cost, and modelling it as a query would let
 * TanStack refetch it on window focus — an installer tabbing back to the console would silently
 * re-probe their estate.
 */
export function useDiscoverCameras() {
  return useMutation({
    mutationFn: (input: DiscoverCamerasInput) => camerasApi.discover(input),
  });
}

/** Bulk onboarding — the DVR/NVR case. Partial success is expected; the caller reads `results`. */
export function useCreateCameras() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cameras: CreateCameraInput[]) => camerasApi.createMany(cameras),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.cameras.all() }),
  });
}

/**
 * Test a camera's connection (P-2).
 *
 * A mutation for the same reason discovery is: it opens a stream on the customer's network and
 * records the measurement. Modelling it as a query would let TanStack re-probe an installer's estate
 * every time they tabbed back to the console.
 */
export function useProbeCamera() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => camerasApi.probe(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.cameras.all() }),
  });
}

/** Re-read capabilities, going back to the device only when that is warranted. */
export function useRefreshCapabilities() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) =>
      camerasApi.refreshCapabilities(id, force ?? false),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.cameras.all() }),
  });
}

/**
 * A camera's retained probe reports (P-2.2).
 *
 * `staleTime: Infinity` on a replay is not a caching optimisation — a stored report cannot change,
 * so refetching one could only ever return the same bytes or reveal that the archive was mutated.
 */
export function useProbeHistory(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.cameras.probes(id ?? ''),
    queryFn: () => camerasApi.probes(id as string),
    enabled: Boolean(id) && enabled,
  });
}

/** Reconstruct one stored probe. Contacts no camera. */
export function useProbeReplay(id: string | undefined, probeId: string | null) {
  return useQuery({
    queryKey: queryKeys.cameras.replay(id ?? '', probeId ?? ''),
    queryFn: () => camerasApi.replayProbe(id as string, probeId as string),
    enabled: Boolean(id) && Boolean(probeId),
    staleTime: Infinity,
  });
}

/** Every record this camera has, in one chronology (P-2.2). */
export function useCameraEvidence(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.cameras.evidence(id ?? ''),
    queryFn: () => camerasApi.evidence(id as string),
    enabled: Boolean(id) && enabled,
  });
}

/** Why the platform did what it did (P-2.3). Explainability only — reads stored evidence. */
export function useCameraDecisions(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.cameras.decisions(id ?? ''),
    queryFn: () => camerasApi.decisions(id as string),
    enabled: Boolean(id) && enabled,
  });
}

/** Retire (decommission, keeping the record) or reinstate a camera. */
export function useCameraLifecycleAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'retire' | 'reinstate' }) =>
      action === 'retire' ? camerasApi.retire(id) : camerasApi.reinstate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.cameras.all() }),
  });
}

/**
 * Is this camera being recorded right now?
 *
 * ⚠️ **A 404 from media is an answer, not a failure.** Measured on the deployment: a camera with no
 * stream worker returns `404 no stream for camera "…"`. That is "nothing is recording this camera",
 * which is a fact an operator needs — reporting it as an error would put a red box on the normal
 * state of every camera nobody has started. Any *other* failure stays unknown, because "we could not
 * reach the media service" and "this camera is not recording" must never render as the same thing.
 */
export function useCameraStream(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.cameras.stream(id ?? ''),
    queryFn: async () => {
      try {
        return await mediaApi.streamStatus(id as string);
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) return null;
        throw err;
      }
    },
    enabled: Boolean(id),
    refetchInterval: 15_000,
  });
}

/** Start or stop recording for one camera (media, `stream:control`). */
export function useStreamControl(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: 'start' | 'stop') =>
      action === 'start' ? mediaApi.startStream(id) : mediaApi.stopStream(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.cameras.stream(id) }),
  });
}
