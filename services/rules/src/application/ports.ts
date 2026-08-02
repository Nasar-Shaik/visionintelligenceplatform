/**
 * Application ports — the seams the rules service depends on, so the CRUD + engine logic is testable
 * without Mongo/Redis/NATS. `RuleStore` persists tenant-scoped rules + their immutable version
 * history; `RuleStateStore` holds bounded, tenant-scoped windowed-threshold state. Concrete Mongo /
 * (future) Redis adapters are wired by the composition root.
 */
import type {
  CreateRuleInput,
  ResolvedRuleScope,
  Rule,
  RuleVersionRecord,
  UpdateRuleInput,
} from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';

export interface RuleStore {
  create(scope: TenantScope, input: CreateRuleInput, actor?: string): Promise<Rule>;
  get(scope: TenantScope, id: string): Promise<Rule | null>;
  list(scope: TenantScope): Promise<Rule[]>;
  /** Rules the engine should evaluate (lifecycle === 'enabled'), for a tenant. */
  listEnabled(scope: TenantScope): Promise<Rule[]>;
  update(
    scope: TenantScope,
    id: string,
    patch: UpdateRuleInput,
    actor?: string,
    /** The scope expansion to store with this version (P-4). Omitted leaves the existing one. */
    resolution?: ResolvedRuleScope,
  ): Promise<Rule | null>;
  remove(scope: TenantScope, id: string, actor?: string): Promise<boolean>;
  listVersions(scope: TenantScope, id: string): Promise<RuleVersionRecord[]>;
}

export interface RuleStateStore {
  /**
   * Record one hit for `key` at `now` and return how many hits fall within the last
   * `windowSeconds`. Backs windowed thresholds ("≥ N within W"). Bounded + tenant-prefixed.
   */
  hitAndCount(key: string, windowSeconds: number, now: Date): Promise<number>;
}

/**
 * What a reference lookup found. `available: false` means the owning context could not be reached —
 * which is **not** the same as "nothing was missing", and the difference is the whole point.
 */
export interface ScopeResolution {
  available: boolean;
  /** Zone ids the scoped nodes expand to, including the nodes themselves when they are zones. */
  zoneIds: string[];
  /** Scoped node ids the hierarchy could not find. */
  missingNodeIds: string[];
  /** Scoped node ids that exist but are archived. */
  archivedNodeIds: string[];
}

/**
 * Reads the Location Hierarchy, which the **Tenant** context owns (P-4).
 *
 * A port rather than an HTTP client, for the reason `StreamProbe` and `DiscoveryProvider` are ports:
 * the service, its tests and every consumer see the seam, never a transport. And a deliberate,
 * bounded shape — this is called **at authoring and validation time, never per event**. The engine's
 * hot path holds a pre-expanded set and cannot reach a hierarchy even in principle.
 *
 * That distinction is what keeps [PLATFORM_BOUNDARIES rule 4](../../../../docs/architecture/PLATFORM_BOUNDARIES.md)
 * intact: the concern there is a synchronous cross-context call in a runtime path, which is how a
 * distributed monolith starts. A validation-time call that fails closed and whose result is
 * snapshotted onto an immutable rule version is a different animal, and it is recorded as an
 * explicit exception in ADR-0026 rather than left to be discovered.
 */
export interface HierarchyProvider {
  resolveScope(scope: TenantScope, nodeIds: readonly string[]): Promise<ScopeResolution>;
}

/** What a camera-existence check found. `available: false` means the check did not run. */
export interface CameraLookup {
  available: boolean;
  missingCameraIds: string[];
}

/** Reads the camera inventory, which the **Camera** context owns. Validation-time only. */
export interface CameraDirectory {
  findMissing(scope: TenantScope, cameraIds: readonly string[]): Promise<CameraLookup>;
}

/**
 * The default when no hierarchy service is configured.
 *
 * It reports **unavailable**, never "everything is fine". An unconfigured deployment therefore
 * refuses to activate a location-scoped rule and says exactly why, rather than quietly enabling a
 * rule whose scope nobody checked. Same posture as `UnavailableDiscoveryProvider` in the camera
 * service (ADR-0023).
 */
export const unavailableHierarchy: HierarchyProvider = {
  async resolveScope() {
    return { available: false, zoneIds: [], missingNodeIds: [], archivedNodeIds: [] };
  },
};

/** The default when no camera service is configured. Reports unavailable, never "all present". */
export const unavailableCameraDirectory: CameraDirectory = {
  async findMissing() {
    return { available: false, missingCameraIds: [] };
  },
};
