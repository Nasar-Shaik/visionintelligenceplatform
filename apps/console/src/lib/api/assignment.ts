import type {
  AssignmentCapacityReport,
  AssignmentHistoryEntry,
  BulkAssignmentRequest,
  BulkAssignmentResult,
  CameraAssignment,
  CameraCapabilityMatrix,
  ProcessingProfile,
  ProcessingRuntime,
  RegisterRuntimeInput,
  UpdateRuntimeInput,
} from '@vip/contracts';
import { http } from './http';

/**
 * Camera Processing Assignment — the control plane, through the gateway (`/api/camera/*`).
 *
 * ⚠️ **Everything here reads or writes the CONTROL PLANE, never the enforcement point.** What an
 * operator decided and what media is doing are two different facts, and the console shows both from
 * their own sources — `assignmentApi` for the decision, `mediaApi` for the measurement. Reading one
 * and labelling it the other is exactly the inference-from-configuration this milestone exists to
 * remove.
 */
export const assignmentApi = {
  list: (params: { state?: string; runtimeId?: string; profileId?: string } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') query.set(key, value);
    }
    const suffix = query.toString();
    return http.get<CameraAssignment[]>(`/camera/assignments${suffix ? `?${suffix}` : ''}`);
  },

  get: (cameraId: string) => http.get<CameraAssignment>(`/camera/assignments/${cameraId}`),

  enable: (cameraId: string, body: { profileId: string; runtimeId?: string; note?: string }) =>
    http.post<CameraAssignment>(`/camera/assignments/${cameraId}/enable`, body),

  /** `runtimeId` omitted ⇒ placement chooses. */
  assignRuntime: (cameraId: string, body: { runtimeId?: string; note?: string }) =>
    http.post<CameraAssignment>(`/camera/assignments/${cameraId}/runtime`, body),

  /**
   * ⚠️ `pause`/`resume` require `assignment:control`; `disable`/`restart` require
   * `assignment:write`. The console gates the buttons the same way the routes do, so an operator is
   * never shown a control that will 403.
   */
  act: (cameraId: string, action: 'disable' | 'pause' | 'resume' | 'restart', note?: string) =>
    http.post<CameraAssignment>(`/camera/assignments/${cameraId}/${action}`, { note }),

  remove: (cameraId: string) => http.del<CameraAssignment>(`/camera/assignments/${cameraId}`),

  bulk: (body: BulkAssignmentRequest) =>
    http.post<BulkAssignmentResult>('/camera/assignments/bulk', body),

  capacity: () => http.get<AssignmentCapacityReport>('/camera/assignments/capacity'),

  history: (params: { cameraId?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.cameraId) query.set('cameraId', params.cameraId);
    if (params.limit) query.set('limit', String(params.limit));
    const suffix = query.toString();
    return http.get<AssignmentHistoryEntry[]>(
      `/camera/assignments/history${suffix ? `?${suffix}` : ''}`,
    );
  },

  profiles: () => http.get<ProcessingProfile[]>('/camera/processing-profiles'),

  runtimes: () => http.get<ProcessingRuntime[]>('/camera/processing-runtimes'),

  registerRuntime: (body: RegisterRuntimeInput) =>
    http.post<ProcessingRuntime>('/camera/processing-runtimes', body),

  updateRuntime: (runtimeId: string, body: UpdateRuntimeInput) =>
    http.patch<ProcessingRuntime>(`/camera/processing-runtimes/${runtimeId}`, body),

  removeRuntime: (runtimeId: string) =>
    http.del<{ reassigned: number; failed: number }>(`/camera/processing-runtimes/${runtimeId}`),

  capabilityMatrix: (cameraId: string) =>
    http.get<CameraCapabilityMatrix>(`/camera/cameras/${cameraId}/capability-matrix`),
};

/**
 * What the **enforcement point** measured, per camera (through media).
 *
 * ⚠️ A separate call to a separate service on purpose. If media is unreachable this fails on its own
 * and the decisions above still render — an operator can still see and change what is assigned while
 * the measurement is missing, which is the state in which they most need to.
 */
export interface CameraProcessingRow {
  cameraId: string;
  aiEnabled: boolean;
  state: string;
  profileId: string | null;
  runtimeId: string | null;
  processingFps: number | null;
  framesOffered: number;
  framesDelivered: number;
  framesSkippedUnassigned: number;
  framesDroppedQueueFull: number;
  queueDepth: number;
  processingLatencyMs: number | null;
  eventsPublished: number | null;
  activeTracks: number | null;
  lastFrameAt: string | null;
  lastError: string | null;
}

export interface AssignmentGateStats {
  enabled: boolean;
  detail?: string;
  planVersion?: number | null;
  plannedCameras?: number;
  cycles?: number;
  failures?: number;
  releases?: number;
  lastPlanAt?: string | null;
  lastError?: string | null;
  runtimes?: { runtimeId: string; health: string; latencyMs: number | null }[];
}

export const assignmentRuntimeApi = {
  /** The gate's engineering view — `system:inspect`. */
  gate: () => http.get<AssignmentGateStats>('/media/perception/assignment'),
  /** Per-camera measurements — `assignment:read`, tenant-scoped. */
  cameras: () =>
    http.get<CameraProcessingRow[] | { enabled: false; detail: string }>(
      '/media/perception/assignment/cameras',
    ),
};
