import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateCameraInput, DiscoverCamerasInput, UpdateCameraInput } from '@vip/contracts';
import { camerasApi } from '@/lib/api/cameras';
import { queryKeys } from '@/lib/queryKeys';

/** Camera registry list (server state). `refetchInterval` enables dashboard polling. */
export function useCameras(options?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: queryKeys.cameras.list(),
    queryFn: () => camerasApi.list(),
    ...(options?.refetchInterval ? { refetchInterval: options.refetchInterval } : {}),
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
  const { data } = useCameras();
  return useCallback(
    (cameraId: string | undefined): string | undefined => {
      if (cameraId === undefined) return undefined;
      return data?.find((camera) => camera.id === cameraId)?.name ?? cameraId;
    },
    [data],
  );
}

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

export function useUpdateCamera(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateCameraInput) => camerasApi.update(id, patch),
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
