/**
 * Domain: the **AI runtime registry** (P-8 Phase 6 §3) — registration, measured health, capacity.
 * Pure and deterministic.
 *
 * ### ⚠️ Registration is declared. Health is measured, and measured by media.
 *
 * An operator declares that a runtime exists at a URL with a capacity. Nothing about its health is
 * taken on that authority. Health arrives from `services/media`, which is the **only** service
 * permitted to talk to the runtime — a deployment property P-8 Phase 1 asserted and the verification
 * still checks.
 *
 * That is not layering pedantry. Media is the process that actually posts frames, so a runtime media
 * can reach is a runtime that can do work, and a runtime only the control plane can reach is a
 * runtime that cannot. Polling from here would have measured a path no frame ever takes — and would
 * have reported a healthy runtime during exactly the outage that matters.
 *
 * ### ⚠️ Nothing here fabricates a health
 *
 * A registered runtime nobody has observed is `unknown`, never `offline`. A runtime whose last
 * observation has expired goes back to `unknown` with `stale: true` — it does not decay to `offline`,
 * because "media stopped reporting" and "the runtime is down" are different failures with different
 * fixes, and guessing between them would send an engineer to the wrong container.
 */
import type { ProcessingRuntime, RuntimeHealth, RuntimeObservation } from '@vip/contracts';
import { PLACEABLE_RUNTIME_HEALTH } from '@vip/contracts';

/** MongoDB-persisted runtime. Platform-wide, not tenant-scoped — see the note on `RuntimeDoc`. */
export interface RuntimeDoc {
  /**
   * ⚠️ **Runtimes are platform infrastructure, not tenant data**, so this collection carries no
   * `tenantId` and is the one place in this service that is not tenant-scoped.
   *
   * A runtime is a container with a GPU; several tenants' cameras run on it, exactly as several
   * tenants' recordings share one media process. Scoping it per tenant would have meant one
   * registration per tenant per container, and a capacity number that meant nothing because it would
   * have been counted N times. Reads are permissioned (`assignment:read`), and the *cameras* on a
   * runtime are always filtered to the caller's tenant — which is where the isolation belongs.
   */
  _id: string;
  name: string;
  url: string;
  labels: string[];
  maxCameras: number;
  enabled: boolean;
  health: RuntimeHealth;
  observedAt: string | null;
  observedBy: string | null;
  latencyMs: number | null;
  detail: string | null;
  capabilities: string[] | null;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

/**
 * How long a runtime observation stays believable. Matches the assignment observation TTL: both come
 * from the same report, so two different windows would mean one report expiring twice.
 */
export const RUNTIME_OBSERVATION_TTL_MS = 45_000;

export function newRuntime(
  input: {
    id: string;
    name: string;
    url: string;
    labels?: string[] | undefined;
    maxCameras: number;
    enabled?: boolean | undefined;
  },
  actor: string,
  at: Date,
): RuntimeDoc {
  const ts = at.toISOString();
  return {
    _id: input.id,
    name: input.name,
    url: input.url,
    labels: input.labels ?? [],
    maxCameras: input.maxCameras,
    enabled: input.enabled ?? true,
    /* ⚠️ `unknown`, not `healthy`. A runtime is not healthy because somebody typed its URL. */
    health: 'unknown',
    observedAt: null,
    observedBy: null,
    latencyMs: null,
    detail: null,
    capabilities: null,
    createdAt: ts,
    updatedAt: ts,
    updatedBy: actor,
  };
}

/** Apply one measurement. The only way a runtime's health ever changes. */
export function applyObservation(
  doc: RuntimeDoc,
  observation: RuntimeObservation,
  reportedBy: string,
  at: Date,
): RuntimeDoc {
  return {
    ...doc,
    health: observation.health,
    observedAt: at.toISOString(),
    observedBy: reportedBy,
    latencyMs: observation.latencyMs,
    detail: observation.detail ?? null,
    /*
     * ⚠️ Capabilities are kept when the observation could not read them. An unreachable runtime has
     * not lost its models — forgetting them would make every profile read `unsupported` during an
     * outage and then flip back, which is a dashboard that lies twice.
     */
    capabilities: observation.capabilities ?? doc.capabilities,
  };
}

/** True when the last observation has expired. A runtime never observed is not stale — it is new. */
export function observationStale(doc: RuntimeDoc, now: Date): boolean {
  if (doc.observedAt === null) return false;
  return now.getTime() - Date.parse(doc.observedAt) > RUNTIME_OBSERVATION_TTL_MS;
}

/**
 * The health to *present*, which is not always the health that was stored.
 *
 * An expired observation reads `unknown`. See the header for why it does not decay to `offline`.
 */
export function effectiveHealth(doc: RuntimeDoc, now: Date): RuntimeHealth {
  if (doc.observedAt === null) return 'unknown';
  return observationStale(doc, now) ? 'unknown' : doc.health;
}

/**
 * Whether a camera may be placed here right now.
 *
 * ⚠️ `unknown` is placeable, and that is deliberate. A deployment that has just started has one
 * registered runtime and no observation yet; refusing to place anything until the first report lands
 * would make the platform unusable for its first minute and would make the very first assignment in
 * a fresh install fail. An unreachable runtime is caught by the *next* observation, which moves the
 * camera by failover — the cost of being wrong is one poll interval, and the cost of the alternative
 * is a deployment that cannot be configured.
 */
export function placeable(doc: RuntimeDoc, now: Date): boolean {
  if (!doc.enabled) return false;
  const health = effectiveHealth(doc, now);
  return health === 'unknown' || (PLACEABLE_RUNTIME_HEALTH as readonly string[]).includes(health);
}

/**
 * Whether this runtime can run a capability.
 *
 * ⚠️ A runtime whose capabilities have never been read (`null`) is treated as **able**, not unable.
 * Same reasoning as `placeable`: excluding unread runtimes would make a fresh deployment unable to
 * place anything at all, and the mistake self-corrects on the first observation.
 */
export function advertises(doc: RuntimeDoc, capabilityId: string): boolean {
  return doc.capabilities === null || doc.capabilities.includes(capabilityId);
}

export function toRuntime(doc: RuntimeDoc, now: Date): ProcessingRuntime {
  return {
    id: doc._id,
    name: doc.name,
    url: doc.url,
    labels: [...doc.labels],
    maxCameras: doc.maxCameras,
    enabled: doc.enabled,
    health: effectiveHealth(doc, now),
    ...(doc.observedAt === null ? {} : { observedAt: doc.observedAt }),
    ...(doc.observedBy === null ? {} : { observedBy: doc.observedBy }),
    latencyMs: doc.latencyMs,
    ...(doc.detail === null ? {} : { detail: doc.detail }),
    capabilities: doc.capabilities === null ? null : [...doc.capabilities],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    ...(doc.updatedBy === undefined ? {} : { updatedBy: doc.updatedBy }),
  };
}
