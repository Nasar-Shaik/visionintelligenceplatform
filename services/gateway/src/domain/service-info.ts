/**
 * Domain: service identity value object. Pure — no framework, no I/O (layering rule:
 * domain never imports transport/adapters). Trivial by design; this is the seat where
 * real Identity-context entities (User, Session, Credential, ApiKey) will live (doc 23).
 */

export interface ServiceInfo {
  readonly name: string;
  readonly version: string;
  readonly startedAt: string;
  readonly uptimeSeconds: number;
}

/** Build a service-info snapshot from primitives (kept pure/testable). */
export function buildServiceInfo(params: {
  name: string;
  version: string;
  startedAt: Date;
  now: Date;
}): ServiceInfo {
  const uptimeSeconds = Math.max(
    0,
    Math.floor((params.now.getTime() - params.startedAt.getTime()) / 1000),
  );
  return {
    name: params.name,
    version: params.version,
    startedAt: params.startedAt.toISOString(),
    uptimeSeconds,
  };
}
