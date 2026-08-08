/**
 * The live-capture feature's reads and writes (P-9).
 *
 * ⚠️ **`open`, `frame` and `close` are plain functions, not mutations.** A frame post happens four
 * to fifteen times a second from inside a pacing loop; routing that through TanStack Query would put
 * every frame in a cache nothing reads, re-render the page on each one, and make the loop's timing
 * depend on React's scheduler. The queries here are for the things an operator *watches* — sessions,
 * processing metrics, tracks — which is exactly what a cache is for.
 */
import { useQuery } from '@tanstack/react-query';
import { http } from '@/lib/api/http';
import { queryKeys } from '@/lib/queryKeys';

/** `GET /media/live/sessions` — every open ingest session for this tenant. */
export interface LiveSession {
  sessionId: string;
  tenantId: string;
  cameraId: string;
  agent: string;
  frameRate: number;
  width: number | null;
  height: number | null;
  startedAt: string;
  lastFrameAt: string | null;
  framesAccepted: number;
  framesRejected: number;
  /** Mean transport age in ms as the *service* measured it. `null` until it believes a sample. */
  arrivalLagMsAvg: number | null;
}

export interface FrameAccepted {
  seq: number;
  /** ⭐ The platform's clock. The browser's `capturedAtMs` is never the frame's time. */
  at: string;
  arrivalLagMs: number | null;
}

/**
 * `GET /media/perception/assignment/cameras` — the enforcement point's own measurements.
 *
 * ⭐ This is the back-pressure instrument, and it is the *platform's* view rather than the
 * browser's. A capture page that reported only what it sent would show a perfectly healthy stream
 * while the sink behind it dropped nine frames in ten.
 */
export interface CameraProcessing {
  cameraId: string;
  aiEnabled: boolean;
  state: 'unassigned' | 'paused' | 'running';
  profileId: string | null;
  runtimeId: string | null;
  processingFps: number | null;
  framesOffered: number;
  framesDelivered: number;
  framesSkippedUnassigned: number;
  framesDroppedQueueFull: number;
  queueDepth: number;
  /** Media → runtime round trip, ms. `null` until one completes — never 0. */
  processingLatencyMs: number | null;
  eventsPublished: number | null;
  activeTracks: number | null;
  lastFrameAt: string | null;
  lastErrorAt?: string;
  lastError?: string;
}

export async function openLiveSession(
  cameraId: string,
  body: { frameRate: number; width?: number; height?: number; agent?: string },
): Promise<LiveSession> {
  return http.post<LiveSession>(`/media/live/${encodeURIComponent(cameraId)}/open`, body);
}

export async function postLiveFrame(
  cameraId: string,
  body: { image: string; capturedAtMs: number },
): Promise<FrameAccepted> {
  return http.post<FrameAccepted>(`/media/live/${encodeURIComponent(cameraId)}/frame`, body);
}

export async function closeLiveSession(cameraId: string): Promise<LiveSession> {
  return http.post<LiveSession>(`/media/live/${encodeURIComponent(cameraId)}/close`, {});
}

/**
 * Sessions this tenant has open, polled.
 *
 * ⚠️ Three seconds. The list exists so an operator can see a capture that a *closed tab* left
 * behind — the reaper takes 60 s to notice, and during that minute the camera is genuinely still
 * claimed. A slower poll would make the page disagree with the platform for longer than the
 * condition itself lasts.
 */
export function useLiveSessions(enabled = true) {
  return useQuery({
    queryKey: queryKeys.livecam.sessions(),
    queryFn: () => http.get<LiveSession[]>('/media/live/sessions'),
    refetchInterval: 3_000,
    refetchIntervalInBackground: false,
    enabled,
    retry: false,
    staleTime: 0,
  });
}

/**
 * Per-camera processing metrics, polled.
 *
 * ⚠️ **One second, and this is the one page where that rate is justified.** Queue depth and drops
 * are transient by definition: a back-pressure episode that lasts three seconds is invisible to a
 * five-second poll, and proving the queue fills and then *recovers* is a requirement of this
 * milestone. It stops when the tab is hidden, like every other poll in the console.
 */
export function useCameraProcessing(enabled = true) {
  return useQuery({
    queryKey: queryKeys.livecam.processing(),
    queryFn: () => http.get<CameraProcessing[]>('/media/perception/assignment/cameras'),
    refetchInterval: 1_000,
    refetchIntervalInBackground: false,
    enabled,
    retry: false,
    staleTime: 0,
  });
}
