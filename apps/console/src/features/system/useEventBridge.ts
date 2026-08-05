import { useQuery } from '@tanstack/react-query';
import { http } from '@/lib/api/http';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The Event Publisher bridge, as the operator page reads it (P-8 Phase 5).
 *
 * ⚠️ **Every average is nullable and that is the contract, not defensive typing.** A publisher that
 * has published nothing returns `null` for its latency and throughput, because "0.00 ms" and "the
 * broker has never been reached" render identically as a number and mean opposite things — and the
 * second one is the answer during an outage (ADR-0039).
 */
export interface EventBridgeStats {
  enabled: boolean;
  /** Set when the bridge is not enabled in this deployment. */
  detail?: string;
  offered: number;
  published: number;
  detectionsPublished: number;
  /** Results that failed contract validation and were never published (fail-closed). */
  rejected: number;
  /** Results with no detections, which would have produced no events. Not an error. */
  suppressed: number;
  /** Results dropped because a camera queue was full — policy, not loss. */
  droppedQueueFull: number;
  /** Results dropped because a newer frame from that camera had already gone out. */
  droppedOutOfOrder: number;
  delayed: number;
  retries: number;
  /** Results that exhausted every attempt. ⚠️ The only one of these that is a fault. */
  failed: number;
  queueDepth: number;
  activeCameras: number;
  inflight: number;
  publishMsAvg: number | null;
  throughputPerSecond: number | null;
  /**
   * ⚠️ `'unknown'` until something has been attempted, never `'up'`. A publisher that has published
   * nothing has not demonstrated a working broker, and showing that as healthy is the failure the
   * whole metrics discipline exists to prevent.
   */
  brokerStatus: 'unknown' | 'up' | 'down';
  lastPublishedAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  /** The payload schema version seen on the wire — reported, never assumed. */
  payloadSchemaVersion?: string;
  publisherVersion: string;
}

/**
 * ⚠️ Five seconds, matching the tracking statistics page rather than the live track list. These are
 * aggregates; they do not move at the frame rate, and a busier poll would put load on the one
 * service that writes evidence for no extra information. Stops when the tab is hidden.
 */
const REFRESH_MS = 5_000;

export function useEventBridge() {
  return useQuery({
    queryKey: queryKeys.health.eventBridge(),
    queryFn: () => http.get<EventBridgeStats>('/system/event-bridge'),
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 0,
  });
}
