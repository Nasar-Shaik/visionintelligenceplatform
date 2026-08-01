import type {
  BulkCreateCamerasResult,
  Camera,
  CameraCapabilities,
  CameraHealthReport,
  CameraHealthSummary,
  CameraProbeReport,
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
export const camerasApi = {
  list: () => http.get<Camera[]>('/camera/cameras'),
  get: (id: string) => http.get<Camera>(`/camera/cameras/${id}`),
  create: (input: CreateCameraInput) => http.post<Camera>('/camera/cameras', input),
  update: (id: string, patch: UpdateCameraInput) =>
    http.patch<Camera>(`/camera/cameras/${id}`, patch),
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
  healthSummary: (id: string, windowHours = 24) =>
    http.get<CameraHealthSummary>(
      `/camera/cameras/${id}/health/summary?windowHours=${windowHours}`,
    ),
  retire: (id: string) => http.post<Camera>(`/camera/cameras/${id}/retire`),
  reinstate: (id: string) => http.post<Camera>(`/camera/cameras/${id}/reinstate`),
};
