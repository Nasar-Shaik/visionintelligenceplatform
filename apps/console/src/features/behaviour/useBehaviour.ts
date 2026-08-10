import { useMutation, useQuery } from '@tanstack/react-query';
import type { BehaviourRule } from '@vip/contracts';
import { behaviourApi } from '@/lib/api/behaviour';

/**
 * Reads for the investigation behaviour surface (Phase 2.4 slice 2.8).
 *
 * ⚠️ **Every read is keyed by the RUN**, never by the analysis. Two runs of one recording are two
 * answers (ADR-0047) and a cache key that lost the run would show one run's behaviour beside the
 * other's video.
 *
 * ⭐ **Nothing polls.** These are projections of a finished run's track history: the answer cannot
 * change while the page is open, so a refetch interval would be a question asked repeatedly whose
 * answer is already known — and each one costs a full recompute in the runtime (measured at 563 ms
 * for a 62-identity camera).
 */
const keys = {
  timeline: (streamId: string, kinds: string, cameraId: string) =>
    ['behaviour', 'timeline', streamId, kinds, cameraId] as const,
  graph: (streamId: string, cameraId: string) => ['behaviour', 'graph', streamId, cameraId] as const,
  primitives: (streamId: string, cameraId: string) =>
    ['behaviour', 'primitives', streamId, cameraId] as const,
  history: (streamId: string, identityId?: string) =>
    ['behaviour', 'track-history', streamId, identityId ?? 'all'] as const,
};

/**
 * ⚠️ Recomputed per request, and never cheap. `staleTime: Infinity` because a finished run's
 * behaviour is immutable — see the note above.
 */
const IMMUTABLE = { staleTime: Infinity, retry: false, gcTime: 10 * 60_000 } as const;

/**
 * ⚠️ **`kinds` is part of the cache key, because it changes the ANSWER and not just the view.**
 *
 * The runtime applies the filter before its entry cap, so an unfiltered read and a filtered one are
 * two different documents — reusing one cache entry for both would show a filtered list that had
 * already lost the facts the filter was asked for.
 */
/**
 * ⛔ **`cameraId` is not decoration on these reads — it is how line geometry is found** (slice 2.9).
 *
 * A crossing is evaluated in the behaviour layer against the camera's line zones, which media looks
 * up from the assignment gate by camera. Omitting it does not fail: the read succeeds and reports
 * `lineGeometry: 'absent'`, meaning *nothing here says whether anybody crossed a line*. That is the
 * honest answer for a caller who did not name a camera, and it is why the panel always names one.
 */
function scope(streamId: string, cameraId: string | undefined) {
  return cameraId === undefined || cameraId === '' ? { streamId } : { streamId, cameraId };
}

export function useBehaviourTimeline(
  streamId: string | undefined,
  kinds: readonly string[] = [],
  enabled = true,
  cameraId?: string,
) {
  /* ⚠️ Sorted, so `['idle','gap']` and `['gap','idle']` are one cache entry rather than two. */
  const key = [...kinds].sort().join(',');
  return useQuery({
    queryKey: keys.timeline(streamId ?? '', key, cameraId ?? ''),
    queryFn: () => {
      const query = scope(streamId!, cameraId);
      return behaviourApi.timeline(key === '' ? query : { ...query, kinds: key });
    },
    enabled: enabled && streamId !== undefined && streamId !== '',
    ...IMMUTABLE,
  });
}

export function useBehaviourGraph(streamId: string | undefined, enabled = true, cameraId?: string) {
  return useQuery({
    queryKey: keys.graph(streamId ?? '', cameraId ?? ''),
    queryFn: () => behaviourApi.graph(scope(streamId!, cameraId)),
    enabled: enabled && streamId !== undefined && streamId !== '',
    ...IMMUTABLE,
  });
}

export function useBehaviourPrimitives(
  streamId: string | undefined,
  enabled = true,
  cameraId?: string,
) {
  return useQuery({
    queryKey: keys.primitives(streamId ?? '', cameraId ?? ''),
    queryFn: () => behaviourApi.primitives(scope(streamId!, cameraId)),
    enabled: enabled && streamId !== undefined && streamId !== '',
    ...IMMUTABLE,
  });
}

/**
 * The movement paths themselves.
 *
 * ⚠️ Fetched **only when an identity is selected**, and that is a size decision rather than a
 * preference: a 98-identity run holds tens of thousands of points, and a trajectory panel that
 * nobody has opened must not pull them all through the edge.
 */
export function useTrackHistory(
  streamId: string | undefined,
  identityId: string | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: keys.history(streamId ?? '', identityId),
    queryFn: () => behaviourApi.trackHistory({ streamId: streamId!, identityId: identityId! }),
    enabled:
      enabled && streamId !== undefined && streamId !== '' && identityId !== undefined && identityId !== '',
    ...IMMUTABLE,
  });
}

/**
 * Evaluate composed rules over this run's graph.
 *
 * ⚠️ A mutation rather than a query even though it changes nothing, because it is **initiated by the
 * operator** and must not run on mount. Evaluating every rule an investigator has half-composed, on
 * every keystroke, would be a browser spending a service's CPU.
 */
export function useEvaluateBehaviour(streamId: string | undefined) {
  return useMutation({
    mutationFn: (rules: BehaviourRule[]) =>
      behaviourApi.evaluate({ streamId: streamId ?? '', rules }),
  });
}
