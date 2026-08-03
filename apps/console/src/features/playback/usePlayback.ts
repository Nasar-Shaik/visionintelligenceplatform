/**
 * Playback data hooks (P-5.5).
 *
 * ⚠️ **A playback session is the one evidence read that must not be cached like the others.**
 * Evidence records are immutable, so the workspace caches them freely. A session carries *signed
 * URLs that expire*, so a cached one is a player that silently stops working partway through a
 * review — and the failure looks like a broken video, not like a stale cache, so nobody reports it
 * correctly. `staleTime` here is derived from the session's own declared expiry rather than picked.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreatePlaybackBookmarkInput, PlaybackSession } from '@vip/contracts';
import { evidenceApi } from '@/lib/api/evidence';
import { incidentsApi } from '@/lib/api/incidents';
import { ApiRequestError } from '@/lib/api/http';
import { queryKeys } from '@/lib/queryKeys';
import { toast } from '@/ui';

/**
 * How long before a session's declared expiry we stop trusting it.
 *
 * ⚠️ A margin, not a coincidence: refetching exactly at expiry races the server clock and the
 * network, and losing that race means a dead URL in a `<video>` element.
 */
const EXPIRY_MARGIN_SECONDS = 60;

/** Milliseconds a session may be reused, from what it actually said about itself. */
export function sessionStaleTime(session: PlaybackSession | undefined): number {
  if (session === undefined) return 0;
  const earliest = session.segments.reduce<number | undefined>(
    (min, segment) =>
      min === undefined ? segment.expiresInSeconds : Math.min(min, segment.expiresInSeconds),
    undefined,
  );
  if (earliest === undefined) return 0;
  return Math.max(0, earliest - EXPIRY_MARGIN_SECONDS) * 1000;
}

/**
 * Resolve a session for one evidence item.
 *
 * ⚠️ `reason` is carried into the **chain of custody**. Watching evidence is accessing evidence;
 * the custody log records `via: 'playback'`, and the incident this was opened from is the sentence
 * somebody will want a year later.
 */
export function usePlaybackSession(evidenceId: string | undefined, reason?: string) {
  return useQuery({
    queryKey: queryKeys.evidence.playback(evidenceId ?? ''),
    queryFn: () => evidenceApi.playback(evidenceId!, reason),
    enabled: evidenceId !== undefined,
    /* Recomputed from the resolved session each time — never a constant guessed up front. */
    staleTime: (query) => sessionStaleTime(query.state.data as PlaybackSession | undefined),
    /*
     * ⚠️ No retry on a 403 or 409. "You may not open this" and "this was purged" are answers, not
     * transient failures, and retrying them three times just delays telling the operator.
     */
    retry: (failureCount, error) => {
      if (error instanceof ApiRequestError && [400, 403, 404, 409].includes(error.status)) {
        return false;
      }
      return failureCount < 2;
    },
  });
}

/** An incident's saved moments, oldest first — a route through the footage. */
export function useBookmarks(incidentId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.incidents.bookmarks(incidentId ?? ''),
    queryFn: () => incidentsApi.bookmarks(incidentId!),
    enabled: incidentId !== undefined,
    retry: (failureCount, error) => {
      /*
       * ⚠️ A 409 here means the deployment has no bookmark store. That is a configuration answer,
       * not a blip — surfaced once as `unavailable`, never retried into a spinner.
       */
      if (error instanceof ApiRequestError && [403, 404, 409].includes(error.status)) return false;
      return failureCount < 2;
    },
  });
}

export function useBookmarkMutations(incidentId: string | undefined) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.incidents.bookmarks(incidentId ?? '') });

  const add = useMutation({
    mutationFn: (input: CreatePlaybackBookmarkInput) =>
      incidentsApi.addBookmark(incidentId!, input),
    onSuccess: async () => {
      await invalidate();
      toast.success('Bookmark saved');
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.status === 409) {
        /* Sealed incident, or no store. Both are stated, neither is retried. */
        toast.error('This incident can no longer be bookmarked', {
          description: error.message,
        });
        return;
      }
      toast.error('Could not save the bookmark', {
        description: error instanceof Error ? error.message : undefined,
      });
    },
  });

  const remove = useMutation({
    mutationFn: (bookmarkId: string) => incidentsApi.removeBookmark(incidentId!, bookmarkId),
    onSuccess: async () => {
      await invalidate();
      toast.success('Bookmark removed');
    },
    onError: () => toast.error('Could not remove the bookmark'),
  });

  return { add, remove };
}
