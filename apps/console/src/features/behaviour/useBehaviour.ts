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
  timeline: (streamId: string, kinds: string) => ['behaviour', 'timeline', streamId, kinds] as const,
  graph: (streamId: string) => ['behaviour', 'graph', streamId] as const,
  primitives: (streamId: string) => ['behaviour', 'primitives', streamId] as const,
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
export function useBehaviourTimeline(
  streamId: string | undefined,
  kinds: readonly string[] = [],
  enabled = true,
) {
  /* ⚠️ Sorted, so `['idle','gap']` and `['gap','idle']` are one cache entry rather than two. */
  const key = [...kinds].sort().join(',');
  return useQuery({
    queryKey: keys.timeline(streamId ?? '', key),
    queryFn: () =>
      behaviourApi.timeline(key === '' ? { streamId: streamId! } : { streamId: streamId!, kinds: key }),
    enabled: enabled && streamId !== undefined && streamId !== '',
    ...IMMUTABLE,
  });
}

export function useBehaviourGraph(streamId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.graph(streamId ?? ''),
    queryFn: () => behaviourApi.graph({ streamId: streamId! }),
    enabled: enabled && streamId !== undefined && streamId !== '',
    ...IMMUTABLE,
  });
}

export function useBehaviourPrimitives(streamId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.primitives(streamId ?? ''),
    queryFn: () => behaviourApi.primitives({ streamId: streamId! }),
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
