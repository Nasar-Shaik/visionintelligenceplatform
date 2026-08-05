import type {
  BulkCreateCamerasResult,
  Camera,
  CameraPage,
  CameraStatus,
  CameraLifecycleState,
  CameraCapabilities,
  CameraHealthReport,
  CameraHealthSummary,
  CameraDecisionLog,
  CameraEvidenceTimeline,
  ConfidenceTrend,
  CameraProbeHistory,
  CameraProbeMetrics,
  CameraProbeReport,
  FleetProbeMetrics,
  ProbeReplay,
  HealthTrendWindow,
  CapabilityRefreshResult,
  CameraValidationInput,
  CameraValidationResult,
  CreateCameraInput,
  DiscoverCamerasInput,
  DiscoverCamerasResult,
  UpdateCameraInput,
} from '@vip/contracts';
import { http } from './http';

/**
 * Camera & device management (through the gateway: `/api/camera/*`).
 *
 * `discover` and `createMany` are the P-1 additions. Note that `discover` is a **POST** even though
 * it reads: it is an active multicast probe against the customer's network, and modelling it as a
 * cacheable GET would let a browser or a proxy replay it.
 */
/** What the server can filter and page on. Mirrors `CameraQuery`; no client-side substitute. */
export interface CameraListQuery {
  search?: string;
  zoneIds?: string[];
  status?: CameraStatus;
  lifecycle?: CameraLifecycleState;
  limit?: number;
  cursor?: string;
}

export const camerasApi = {
  /**
   * ⚠️ **Always a page, and always the server's answer.**
   *
   * `GET /cameras` returns a bare array when it is given no parameters at all and a `CameraPage`
   * when it is given any — two shapes from one route. Sending a `limit` every time removes the
   * ambiguity, and it is the honest call anyway: the console used to ask for the entire estate and
   * then search, filter and count it in the browser, which works at nine cameras and is a different
   * product at five thousand.
   */
  list: (query: CameraListQuery = {}) =>
    http.get<CameraPage>('/camera/cameras', {
      query: {
        limit: query.limit ?? 50,
        ...(query.search ? { search: query.search } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.lifecycle ? { lifecycle: query.lifecycle } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.zoneIds?.length ? { zoneId: query.zoneIds } : {}),
      },
    }),
  get: (id: string) => http.get<Camera>(`/camera/cameras/${id}`),
  create: (input: CreateCameraInput) => http.post<Camera>('/camera/cameras', input),
  /**
   * ⚠️ `expectedUpdatedAt` is the record as the operator loaded it, sent as `If-Match`.
   *
   * Measured at P-6.6: without it, two administrators editing one camera both received HTTP 200 and
   * one edit was silently discarded. The server puts the value in the write's filter, so the loser
   * is told (409) rather than overwriting work it never saw.
   */
  update: (id: string, patch: UpdateCameraInput, expectedUpdatedAt?: string) =>
    http.patch<Camera>(`/camera/cameras/${id}`, patch, {
      ...(expectedUpdatedAt ? { headers: { 'If-Match': expectedUpdatedAt } } : {}),
    }),
  remove: (id: string) => http.del<void>(`/camera/cameras/${id}`),
  health: (id: string) => http.get<CameraHealthReport>(`/camera/cameras/${id}/health`),
  capabilities: (id: string) => http.get<CameraCapabilities>(`/camera/cameras/${id}/capabilities`),
  validate: (input: CameraValidationInput) =>
    http.post<CameraValidationResult>('/camera/cameras/validate', input),
  discover: (input: DiscoverCamerasInput) =>
    http.post<DiscoverCamerasResult>('/camera/cameras/discover', input),
  createMany: (cameras: CreateCameraInput[]) =>
    http.post<BulkCreateCamerasResult>('/camera/cameras/bulk', { cameras }),
  checkHealth: (id: string) => http.post<CameraHealthReport>(`/camera/cameras/${id}/health/check`),
  setStatus: (id: string, status: 'enabled' | 'disabled') =>
    http.post<Camera>(`/camera/cameras/${id}/${status === 'enabled' ? 'enable' : 'disable'}`),
  // P-2. `probe` is a POST for the same reason `discover` is: it opens a stream on the customer's
  // network and writes what it measured.
  probe: (id: string) => http.post<CameraProbeReport>(`/camera/cameras/${id}/probe`),
  refreshCapabilities: (id: string, force = false) =>
    http.post<CapabilityRefreshResult>(
      `/camera/cameras/${id}/capabilities/refresh${force ? '?force=true' : ''}`,
    ),
  healthSummary: (id: string, window: HealthTrendWindow = 'day') =>
    http.get<CameraHealthSummary>(`/camera/cameras/${id}/health/summary?window=${window}`),
  // P-2.2 — the immutable probe archive. Every one of these is a GET: they read stored evidence and
  // contact no camera. `replay` in particular must never become a POST, because a support engineer
  // reading a week-old failure would then be re-testing a camera that has since been rebooted.
  probes: (id: string, limit = 50) =>
    http.get<CameraProbeHistory>(`/camera/cameras/${id}/probes?limit=${limit}`),
  replayProbe: (id: string, probeId: string) =>
    http.get<ProbeReplay>(`/camera/cameras/${id}/probes/${probeId}`),
  probeMetrics: (id: string, window: HealthTrendWindow = 'day') =>
    http.get<CameraProbeMetrics>(`/camera/cameras/${id}/probes/metrics?window=${window}`),
  evidence: (id: string, window: HealthTrendWindow = 'month') =>
    http.get<CameraEvidenceTimeline>(`/camera/cameras/${id}/evidence?window=${window}`),
  decisions: (id: string, window: HealthTrendWindow = 'month') =>
    http.get<CameraDecisionLog>(`/camera/cameras/${id}/decisions?window=${window}`),
  confidenceTrend: (id: string, window: HealthTrendWindow = 'month') =>
    http.get<ConfidenceTrend>(`/camera/cameras/${id}/confidence?window=${window}`),
  fleetMetrics: (window: HealthTrendWindow = 'day') =>
    http.get<FleetProbeMetrics>(`/camera/cameras/metrics?window=${window}`),
  retire: (id: string) => http.post<Camera>(`/camera/cameras/${id}/retire`),
  reinstate: (id: string) => http.post<Camera>(`/camera/cameras/${id}/reinstate`),
};
