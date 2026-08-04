import type { SystemHealth } from '@vip/contracts';
import { http } from './http';

/**
 * The platform's view of itself (P-6.4) — **one call, not ten.**
 *
 * The gateway assembles the report: it asks every service's readiness probe inside the cluster,
 * derives the infrastructure rows from what those services say about their own dependencies, and
 * adds the capabilities this release does not contain. The console renders it and derives nothing,
 * so "is Events healthy" has exactly one answer in the product.
 *
 * ⚠️ There is deliberately no per-service call here. Ten readiness probes from a browser is ten
 * round trips and ten tokens to answer a question about the deployment rather than about the caller.
 */
export const systemApi = {
  health: () => http.get<SystemHealth>('/system/health'),
};
