import type { Camera } from '@vip/contracts';
import { http } from './http';

/** Camera registry reads (through the gateway: `/api/camera/*`). */
export const camerasApi = {
  list: () => http.get<Camera[]>('/camera/cameras'),
  get: (id: string) => http.get<Camera>(`/camera/cameras/${id}`),
};
