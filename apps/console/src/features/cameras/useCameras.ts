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
