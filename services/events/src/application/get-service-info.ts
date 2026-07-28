/**
 * Application use-case: assemble the current service-info snapshot. Thin by design — composes
 * config + clock into the pure domain builder (transport → application → domain call direction).
 */
import { buildServiceInfo, type ServiceInfo } from '../domain/service-info.js';

export interface ServiceInfoDeps {
  readonly name: string;
  readonly version: string;
  readonly startedAt: Date;
  readonly now?: () => Date;
}

export function getServiceInfo(deps: ServiceInfoDeps): ServiceInfo {
  const now = deps.now ? deps.now() : new Date();
  return buildServiceInfo({
    name: deps.name,
    version: deps.version,
    startedAt: deps.startedAt,
    now,
  });
}
