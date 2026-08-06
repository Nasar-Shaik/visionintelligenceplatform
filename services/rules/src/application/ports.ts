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
  RuleCacheStats,
  RuleDwell,
  RuleRuntimeStats,
  RuleStatsHistory,
  RuleVersionRecord,
  UpdateRuleInput,
} from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import type { DwellObservationInput, DwellOutcome, DwellRecord } from '../domain/dwell.js';

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
  /**
   * Replace a rule's content with an earlier version's, as a new version (P-4.1, Architect rec 7).
   *
   * Separate from `update` because a patch cannot express absence: rolling back through `update` would
   * leave fields the target version did not have. See `restoreVersion`.
   */
  restore(
    scope: TenantScope,
    id: string,
    target: Rule,
    actor?: string,
    resolution?: ResolvedRuleScope,
  ): Promise<Rule | null>;
}

/**
 * Live operational numbers, read by the diagnostics route (P-4.1, Architect recs 3 + 8).
 *
 * A **port supplied by the composition root**, not a dependency on the engine — for the same reason
 * `onRulesChanged` is a callback: the authoring service must not know that an evaluation engine
 * exists, let alone hold one. Absent in a deployment that runs authoring and evaluation as separate
 * processes, where this node genuinely has no numbers to report, and the route says so rather than
 * reporting zeroes as though they were measurements.
 */
export interface RuleDiagnostics {
  node: string;
  uptimeSeconds(): number;
  /**
   * Cache health, or `undefined` when this node is not evaluating — which includes the window before
   * the engine has started. Optional in the return type rather than zeroed, because an unstarted
   * engine and an idle one produce identical zeroes and only one of them is worth paging about.
   */
  cacheStats(tenantId: string): RuleCacheStats | undefined;
  ruleStats(tenantId: string): RuleRuntimeStats[];
  /** Recent activity for one rule on this node (P-4.2). Empty when the rule has never been compiled. */
  history(tenantId: string, ruleId: string): RuleStatsHistory;
}

export interface RuleStateStore {
  /**
   * Record one hit for `key` at `now` and return how many hits fall within the last
   * `windowSeconds`. Backs windowed thresholds ("≥ N within W"). Bounded + tenant-prefixed.
   */
  hitAndCount(key: string, windowSeconds: number, now: Date): Promise<number>;
}

/** How much dwell state this node is holding (P-8 Phase 7). Operational; nothing reads it to decide. */
export interface DwellStoreStats {
  /** Visits currently being tracked. */
  entries: number;
  /** The ceiling before eviction starts. Reported so `entries` can be judged against it. */
  maxEntries: number;
  observations: number;
  /**
   * Visits dropped because the store was full.
   *
   * ⚠️ A non-zero value means some subject's dwell was silently forgotten and their rule will not
   * fire. It is a capacity signal, not a tuning knob — see `InMemoryDwellStateStore`.
   */
  evicted: number;
  /** Visits dropped because they aged past any rule's horizon. Normal and expected. */
  expired: number;
}

/**
 * Names a detection zone, synchronously, for a candidate's explanation (P-8 Phase 7).
 *
 * ⚠️ Returns `undefined` for an unknown zone, and the caller must fall back to the zone **id** rather
 * than to a placeholder name. "Zone 1" or "Unknown zone" on an incident record is worse than a raw id
 * — an id can be looked up, an invented name cannot, and one of them looks authoritative.
 */
export type ZoneLookup = (
  tenantId: string,
  zoneId: string | undefined,
) => { name: string; version: number } | undefined;

/**
 * Holds one subject's presence in one zone between events (P-8 Phase 7).
 *
 * A **separate port from `RuleStateStore`**, deliberately. A window is a bag of timestamps and a
 * count; a visit is a structured record with a lifecycle, a cool-down and a timeline. Squeezing dwell
 * through `hitAndCount` would have meant re-deriving the visit from timestamps on every event, and
 * would have made the cool-down — which is state that must survive the observations inside it —
 * inexpressible.
 */
export interface DwellStateStore {
  /**
   * Fold one observation into a subject's visit and return what it did.
   *
   * ⚠️ The store owns *retention*; `domain/dwell.observe` owns *semantics*. Every decision about
   * thresholds, resets and cool-downs is made by the pure function, so an alternative store
   * (Redis, say) cannot accidentally change what loitering means.
   */
  observe(key: string, input: DwellObservationInput, config: RuleDwell): Promise<DwellOutcome>;
  stats(): DwellStoreStats;
  /**
   * Every visit currently being tracked, for the Live Rule Status page (P-8 Phase 7, recs 3 + 6).
   *
   * ⚠️ **Read-only and derived.** The state a visit is in is a function of its record and its rule's
   * configuration, so it is computed on read rather than stored — a stored copy could disagree with
   * the record it describes. Nothing about evaluation depends on anyone calling this.
   */
  active(): { key: string; record: DwellRecord }[];
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

/** What a camera-group expansion found (P-8 Phase 7). `available: false` means it did not run. */
export interface GroupResolution {
  available: boolean;
  /** Every camera in every named group, deduplicated. */
  cameraIds: string[];
  missingGroupIds: string[];
  /**
   * Groups that exist and contain no cameras.
   *
   * ⚠️ Reported separately from `missingGroupIds` because they are a different mistake with the same
   * symptom. A rule scoped to an empty group covers nothing and looks exactly like a rule scoped to a
   * group that was deleted — and the fix is different in each case. Neither is an error: a group
   * filled in later is a legitimate way to work.
   */
  emptyGroupIds: string[];
}

/** What a detection-zone check found (P-8 Phase 7). `available: false` means it did not run. */
export interface ZoneResolution {
  available: boolean;
  missingZoneIds: string[];
  /**
   * Zones that exist but are switched off.
   *
   * ⚠️ A **warning, never an error**. Disabling a zone is a normal operational act and must not
   * un-validate every rule that mentions it — but a rule whose only zone is disabled will never fire,
   * and an operator who cannot see that will spend an afternoon on it.
   */
  disabledZoneIds: string[];
  /** Zones whose camera is not covered by the rule's camera scope, when the rule names cameras. */
  zoneCameraIds: Record<string, string>;
}

/** Reads the camera inventory, which the **Camera** context owns. Validation-time only. */
export interface CameraDirectory {
  findMissing(scope: TenantScope, cameraIds: readonly string[]): Promise<CameraLookup>;
  /**
   * Expand camera groups into cameras (P-8 Phase 7).
   *
   * ⚠️ **Validation-time only, exactly like `resolveScope`.** The expansion is snapshotted onto the
   * immutable rule version; the engine holds a set and cannot reach a group even in principle. This
   * is the same explicitly-recorded exception to PLATFORM_BOUNDARIES rule 4 that ADR-0026 made for
   * the hierarchy, for the same reason and with the same fail-closed posture.
   */
  resolveGroups(scope: TenantScope, groupIds: readonly string[]): Promise<GroupResolution>;
  /** Check that named detection zones exist and are enabled (P-8 Phase 7). Validation-time only. */
  resolveZones(scope: TenantScope, zoneIds: readonly string[]): Promise<ZoneResolution>;
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
  async resolveGroups() {
    return { available: false, cameraIds: [], missingGroupIds: [], emptyGroupIds: [] };
  },
  async resolveZones() {
    return { available: false, missingZoneIds: [], disabledZoneIds: [], zoneCameraIds: {} };
  },
};
