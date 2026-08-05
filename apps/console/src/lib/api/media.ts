import type { StreamStatus } from '@vip/contracts';
import { http } from './http';

/**
 * Media — per-camera stream workers (through the gateway: `/api/media/*`).
 *
 * ⚠️ **Deliberately three calls, not a media catalogue.** The clip/recording surface is C-14 and a
 * milestone of its own; what P-6.6 needs is the answer to one question an operator asks on a camera
 * page — *is this camera being recorded, and can I start or stop it?* — which the media service
 * already answers per camera.
 *
 * ⚠️ Stream state is **in-memory in the media service** (TD-4): a restart of that service clears
 * every worker, so a camera that was recording stops and nothing in the record says it ever was.
 * The camera page states this rather than presenting the reading as durable configuration.
 */
export const mediaApi = {
  streamStatus: (cameraId: string) => http.get<StreamStatus>(`/media/streams/${cameraId}/status`),
  startStream: (cameraId: string) => http.post<StreamStatus>(`/media/streams/${cameraId}/start`),
  stopStream: (cameraId: string) => http.post<StreamStatus>(`/media/streams/${cameraId}/stop`),
};
