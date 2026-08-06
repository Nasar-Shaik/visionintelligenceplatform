import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateDetectionZoneInput, UpdateDetectionZoneInput } from '@vip/contracts';
import { ruleLiveApi, zonesApi } from '@/lib/api/zones';
import { queryKeys } from '@/lib/queryKeys';

/**
 * Detection zones and live rule status, as the operator pages read them (P-8 Phase 7).
 *
 * ### ⚠️ Configuration and live state are separate queries, deliberately
 *
 * The same split Camera Processing Assignment made, for the same reason. `useZones` reads what an
 * operator drew; `useLiveRuleStatus` reads what the engine is doing about it. They fail
 * independently — when the rules engine is unreachable an operator can still edit zones, which is
 * often exactly what they are trying to do.
 *
 * ⚠️ A `503` from live status means *this node does not evaluate*. It is not retried: retrying a
 * correct answer produces load and no new information, and the page says what it means rather than
 * spinning.
 */

/** ⚠️ Two seconds. A loiter timer that updated every five would visibly lag the footage beside it. */
const LIVE_REFRESH_MS = 2_000;

export function useZones(cameraId?: string) {
  return useQuery({
    queryKey: queryKeys.zones.list(cameraId),
    queryFn: () => zonesApi.list(cameraId),
    retry: false,
  });
}

export function useZoneVersions(zoneId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.zones.versions(zoneId ?? ''),
    queryFn: () => zonesApi.versions(zoneId as string),
    enabled: Boolean(zoneId),
    retry: false,
  });
}

/**
 * Live rule status, including the running dwell clocks.
 *
 * ⚠️ `refetchIntervalInBackground: false` — a status page left open on a spare monitor must not poll
 * a rules node for ever. The same rule every other live page here follows.
 */
export function useLiveRuleStatus() {
  return useQuery({
    queryKey: queryKeys.rules.live(),
    queryFn: () => ruleLiveApi.status(),
    refetchInterval: LIVE_REFRESH_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export function useDryRunSummaries() {
  return useQuery({
    queryKey: queryKeys.rules.dryRuns(),
    queryFn: () => ruleLiveApi.dryRuns(),
    refetchInterval: LIVE_REFRESH_MS * 5,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export function useRuleTemplates() {
  return useQuery({
    queryKey: queryKeys.rules.templates(),
    queryFn: () => ruleLiveApi.templates(),
    /* Compiled into the service — it cannot change without a deploy, so it need never be refetched. */
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * Zone writes.
 *
 * ⚠️ Every one invalidates the zone list **and** live rule status. Drawing a zone changes what the
 * engine watches within one plan poll, and a page still showing "2 active zones" after a third was
 * added would make an operator think the save had not taken.
 */
export function useZoneMutations(cameraId?: string) {
  const client = useQueryClient();
  const invalidate = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: queryKeys.zones.list(cameraId) });
    await client.invalidateQueries({ queryKey: queryKeys.rules.live() });
  };

  const create = useMutation({
    mutationFn: (input: CreateDetectionZoneInput) => zonesApi.create(input),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ zoneId, patch }: { zoneId: string; patch: UpdateDetectionZoneInput }) =>
      zonesApi.update(zoneId, patch),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (zoneId: string) => zonesApi.remove(zoneId),
    onSuccess: invalidate,
  });

  return { create, update, remove };
}
