import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BulkAssignmentRequest } from '@vip/contracts';
import { assignmentApi, assignmentRuntimeApi } from '@/lib/api/assignment';
import { queryKeys } from '@/lib/queryKeys';

/**
 * Camera Processing Assignment, as the operator pages read it (P-8 Phase 6).
 *
 * ### ⚠️ Decisions and measurements are separate queries, deliberately
 *
 * `useAssignments` reads the **control plane** (what an operator authorised); `useProcessingMetrics`
 * reads the **enforcement point** (what media is doing). They fail independently, and that is the
 * point: when media is unreachable an operator can still see and change assignments, which is
 * precisely the situation in which they need to.
 *
 * Merging them into one hook would also have made a stale measurement look like a changed decision.
 */

/**
 * ⚠️ Five seconds, matching the enforcement point's own poll interval. Faster would show an operator
 * a decision that has not reached media yet and make a correct system look broken; slower would make
 * "I paused it, did it stop?" unanswerable for longer than an operator will wait.
 */
const REFRESH_MS = 5_000;

export function useAssignments(filter: { state?: string; runtimeId?: string } = {}) {
  return useQuery({
    queryKey: queryKeys.assignment.list(filter),
    queryFn: () => assignmentApi.list(filter),
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export function useProcessingProfiles() {
  return useQuery({
    queryKey: queryKeys.assignment.profiles(),
    queryFn: () => assignmentApi.profiles(),
    retry: false,
  });
}

export function useProcessingRuntimes() {
  return useQuery({
    queryKey: queryKeys.assignment.runtimes(),
    queryFn: () => assignmentApi.runtimes(),
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export function useAssignmentCapacity() {
  return useQuery({
    queryKey: queryKeys.assignment.capacity(),
    queryFn: () => assignmentApi.capacity(),
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export function useAssignmentHistory(params: { cameraId?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: queryKeys.assignment.history(params),
    queryFn: () => assignmentApi.history(params),
    retry: false,
  });
}

/** The enforcement point's engineering view. Fails on its own — see the header. */
export function useAssignmentGate() {
  return useQuery({
    queryKey: queryKeys.assignment.gate(),
    queryFn: () => assignmentRuntimeApi.gate(),
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

/** Per-camera measurements from media. Fails on its own — see the header. */
export function useProcessingMetrics() {
  return useQuery({
    queryKey: queryKeys.assignment.metrics(),
    queryFn: () => assignmentRuntimeApi.cameras(),
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

/**
 * Every mutation invalidates the assignment tree.
 *
 * ⚠️ The list, capacity and history all change together after any action — a camera moving to a
 * runtime changes its row, that runtime's occupancy and the audit trail in one write. Invalidating
 * only the list would leave a capacity page insisting there is room that has just been taken.
 */
function useAssignmentMutation<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.assignment.all() });
    },
  });
}

export function useEnableAssignment() {
  return useAssignmentMutation(
    (args: { cameraId: string; profileId: string; runtimeId?: string }) =>
      assignmentApi.enable(args.cameraId, {
        profileId: args.profileId,
        ...(args.runtimeId === undefined ? {} : { runtimeId: args.runtimeId }),
      }),
  );
}

export function useAssignmentAction() {
  return useAssignmentMutation(
    (args: { cameraId: string; action: 'disable' | 'pause' | 'resume' | 'restart' }) =>
      assignmentApi.act(args.cameraId, args.action),
  );
}

export function useAssignCameraRuntime() {
  return useAssignmentMutation((args: { cameraId: string; runtimeId: string }) =>
    assignmentApi.assignRuntime(args.cameraId, { runtimeId: args.runtimeId }),
  );
}

/**
 * A bulk operation over many cameras (§7).
 *
 * ⚠️ The result is **returned**, not swallowed into a toast. A bulk operation can be `partial` — the
 * deployment runs a standalone MongoDB with no multi-document transactions, so a fault during the
 * write phase can leave some items applied — and the caller has to be able to show which. A hook
 * that reported only success/failure would erase the one thing the contract exists to carry.
 */
export function useBulkAssignment() {
  return useAssignmentMutation((request: BulkAssignmentRequest) => assignmentApi.bulk(request));
}

export function useUpdateRuntime() {
  return useAssignmentMutation(
    (args: { runtimeId: string; patch: { maxCameras?: number; enabled?: boolean } }) =>
      assignmentApi.updateRuntime(args.runtimeId, args.patch),
  );
}
