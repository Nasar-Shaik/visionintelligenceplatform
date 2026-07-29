import type { Principal, TokenPair } from '@vip/contracts';
import { http } from './http';

/**
 * Identity/auth endpoints (through the gateway: `/api/identity/auth/*`). Login is scoped to
 * a tenant via the `x-tenant-id` header (the backend uses it to locate the user; it is not a
 * privilege claim). Refresh/logout present the refresh token in the body.
 */
export const authApi = {
  login: (tenantId: string, input: { email: string; password: string }) =>
    http.post<TokenPair>('/identity/auth/login', input, { headers: { 'x-tenant-id': tenantId } }),
  refresh: (refreshToken: string) =>
    http.post<TokenPair>('/identity/auth/refresh', { refreshToken }),
  logout: (refreshToken: string) => http.post<void>('/identity/auth/logout', { refreshToken }),
  me: () => http.get<Principal>('/identity/auth/me'),
};
