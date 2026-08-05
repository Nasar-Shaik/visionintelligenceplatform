import { useQuery } from '@tanstack/react-query';
import { http } from '@/lib/api/http';
import { queryKeys } from '@/lib/queryKeys';

/**
 * Object tracking, as the operator pages read it (P-8 Phase 4).
 *
 * ⚠️ **Every field is optional and every derived average is nullable**, and that is not defensive
 * typing — it is the contract. A runtime that has tracked nothing returns `null` for average
 * lifetime, not `0`, because "0.0 s" and "nobody has walked past a camera" render identically and
 * mean opposite things. The pages must be able to tell them apart, so the types must too.
 *
 * ⚠️ **Distances are normalized image units, not metres.** `averageSpeedNormalized` is frame widths
 * per second. Converting needs camera calibration this platform does not have — see the contract.
 */
export interface TrackMotion {
  durationSeconds: number;
  pathLengthNormalized: number;
  displacementNormalized: number;
  averageSpeedNormalized: number;
  currentSpeedNormalized: number;
  dwellSeconds: number;
  samples: number;
  headingDegrees?: number;
  headingLabel?: string;
  straightness?: number;
}

export type TrackState = 'created' | 'tentative' | 'confirmed' | 'lost' | 'removed';

export interface TrackHistoryPoint {
  frameIndex: number;
  at: string;
  bbox: [number, number, number, number];
  centroid?: [number, number];
}

export interface Track {
  schemaVersion?: string;
  trackId: string;
  tenantId: string;
  cameraId: string;
  sessionId?: string;
  label: string;
  classId?: number;
  state: TrackState;
  confidence: number;
  bbox: [number, number, number, number];
  centroid?: [number, number];
  firstSeen: { frameIndex: number; at: string };
  lastSeen: { frameIndex: number; at: string };
  age: number;
  hits: number;
  quality: {
    trackingConfidence?: number;
    occlusionRatio?: number;
    visibility?: number;
    predictionFrames?: number;
    lostFrames?: number;
  };
  history: TrackHistoryPoint[];
  motion?: TrackMotion;
  /** The first trackId in this identity's chain. Equal to `trackId` for a first appearance. */
  identityId?: string;
  /** The trackId this one re-entered from, when the engine linked a gap. */
  precededBy?: string;
  recoveries?: number;
  attributes: Record<string, unknown>;
}

export interface TrackTimelineEntry {
  frameIndex: number;
  at: string;
  from?: TrackState | null;
  to: TrackState;
  reason?: string;
}

export interface TrackingStats {
  camerasTracked: number;
  activeTracks: number;
  confirmedTracks: number;
  tentativeTracks: number;
  lostTracks: number;
  removedTracks: number;
  createdTracks: number;
  recoveredTracks: number;
  framesTracked: number;
  outOfOrderFrames?: number;
  averageTrackingMs: number | null;
  averageTrackLifetimeSeconds: number | null;
  averageTrackHits: number | null;
  fragmentation: number | null;
  camerasEvicted?: number;
}

export interface TrackingEngine {
  enabled: boolean;
  associator: string;
  minIou: number;
  minIouLost: number;
  minHits: number;
  maxAgeFrames: number;
  historyMax: number;
  reentryGapSeconds: number;
  reentryDistance: number;
}

/** `/api/tracking` — statistics, plus what the engine is. */
export interface TrackingOverview {
  enabled: boolean;
  /** Set when tracking is off, not configured, or the runtime could not be reached. */
  detail?: string;
  unreachable?: boolean;
  engine?: TrackingEngine;
  stats?: TrackingStats;
}

/** `/api/tracking/tracks` */
export interface TrackListing {
  enabled?: boolean;
  detail?: string;
  unreachable?: boolean;
  tracks?: Track[];
  stats?: TrackingStats;
}

/** `/api/tracking/tracks/:id` */
export interface TrackDetail {
  track: Track;
  timeline: TrackTimelineEntry[];
}

/**
 * ⚠️ Two seconds, not five, and only on the live list.
 *
 * A track list is a moving scene — at the deployment's 2 fps a slower poll shows an operator where
 * people *were*, and the whole value of the page is that it is current. The statistics page polls
 * at five: aggregates do not move fast enough to be worth the request, and the two pages are
 * deliberately not sharing a key so refreshing one does not invalidate the other.
 *
 * Both stop when the tab is hidden. A forgotten wall display must not become permanent load on the
 * one service that writes evidence.
 */
const LIVE_INTERVAL_MS = 2_000;
const STATS_INTERVAL_MS = 5_000;

export function useTrackingOverview() {
  return useQuery({
    queryKey: queryKeys.tracking.overview(),
    queryFn: () => http.get<TrackingOverview>('/tracking'),
    refetchInterval: STATS_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 0,
  });
}

export function useLiveTracks(params: { cameraId?: string; state?: string } = {}) {
  const search = new URLSearchParams();
  if (params.cameraId) search.set('cameraId', params.cameraId);
  if (params.state) search.set('state', params.state);
  const query = search.size > 0 ? `?${search.toString()}` : '';
  return useQuery({
    queryKey: queryKeys.tracking.list(params),
    queryFn: () => http.get<TrackListing>(`/tracking/tracks${query}`),
    refetchInterval: LIVE_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 0,
  });
}

export function useTrackDetail(trackId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.tracking.detail(trackId ?? ''),
    queryFn: () => http.get<TrackDetail>(`/tracking/tracks/${encodeURIComponent(trackId ?? '')}`),
    enabled: trackId !== undefined && trackId !== '',
    refetchInterval: LIVE_INTERVAL_MS,
    refetchIntervalInBackground: false,
    /*
     * ⚠️ No retry, and a 404 is expected rather than exceptional. A track that ends while an
     * operator is reading its detail page is the ordinary case on a live scene — retrying it three
     * times only delays telling them so.
     */
    retry: false,
    staleTime: 0,
  });
}
