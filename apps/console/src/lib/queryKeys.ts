/**
 * Centralised TanStack Query keys — the one place cache keys are defined so
 * invalidation stays consistent across features (state strategy §11).
 * Each feature adds its namespace here rather than inlining string arrays.
 */
export const queryKeys = {
  auth: {
    me: () => ['auth', 'me'] as const,
  },
  // P-6.2. User administration. Every write here (re-role, disable, enable, password) changes a
  // row the list renders, and the list is small and unpaged — so writes invalidate `all()` rather
  // than patching a cached row, which would leave `updatedAt` stale.
  users: {
    all: () => ['users'] as const,
    list: () => ['users', 'list'] as const,
    detail: (id: string) => ['users', 'detail', id] as const,
  },
  // P-3. The estate. A move rewrites descendants and an archive cascades, so writes invalidate
  // `all()` rather than a node — the set of changed nodes is the traversal the server just did.
  organization: {
    all: () => ['organization'] as const,
    // P-6.3. The tenant record itself. Keyed apart from the estate: renaming the tenant must not
    // refetch the whole hierarchy, and archiving a location must not refetch the tenant.
    tenant: (tenantId: string) => ['organization', 'tenant', tenantId] as const,
    tree: (under?: string) => ['organization', 'tree', under ?? null] as const,
    locations: (params?: Record<string, unknown>) =>
      ['organization', 'locations', params ?? {}] as const,
    location: (id: string) => ['organization', 'location', id] as const,
  },
  cameras: {
    all: () => ['cameras'] as const,
    list: (params?: Record<string, unknown>) => ['cameras', 'list', params ?? {}] as const,
    detail: (id: string) => ['cameras', 'detail', id] as const,
    // P-2.2. Probe reports are immutable, so a fetched report never needs refetching — only the
    // *list* grows. Keyed separately from the camera so probing does not invalidate a replay.
    probes: (id: string) => ['cameras', 'probes', id] as const,
    replay: (id: string, probeId: string) => ['cameras', 'probes', id, probeId] as const,
    evidence: (id: string) => ['cameras', 'evidence', id] as const,
    decisions: (id: string) => ['cameras', 'decisions', id] as const,
    /** P-6.6 — the estate's own count, so "showing 50 of N" is the server's N and not a page size. */
    fleet: (window: string) => ['cameras', 'fleet', window] as const,
    healthSummary: (id: string, window: string) =>
      ['cameras', 'health-summary', id, window] as const,
    probeMetrics: (id: string, window: string) => ['cameras', 'probe-metrics', id, window] as const,
    confidence: (id: string, window: string) => ['cameras', 'confidence', id, window] as const,
    /** The id→name map. Bounded and long-lived: names change rarely and this is read everywhere. */
    names: () => ['cameras', 'names'] as const,
    /** Media's per-camera stream worker — a different service's answer, keyed separately. */
    stream: (id: string) => ['cameras', 'stream', id] as const,
  },
  events: {
    all: () => ['events'] as const,
    list: (params?: Record<string, unknown>) => ['events', 'list', params ?? {}] as const,
  },
  rules: {
    all: () => ['rules'] as const,
    list: (params?: Record<string, unknown>) => ['rules', 'list', params ?? {}] as const,
    detail: (id: string) => ['rules', 'detail', id] as const,
    // P-4. Keyed apart from the rule: re-checking references must not refetch the rule itself.
    validation: (id: string) => ['rules', 'validation', id] as const,
  },
  incidents: {
    all: () => ['incidents'] as const,
    list: (params?: Record<string, unknown>) => ['incidents', 'list', params ?? {}] as const,
    detail: (id: string) => ['incidents', 'detail', id] as const,
    // P-5.2. The workspace's derived reads. Keyed apart from the incident so opening the timeline
    // does not refetch the record, and so a transition invalidates all four together.
    activity: (id: string) => ['incidents', 'activity', id] as const,
    timeline: (id: string, include: readonly string[]) =>
      ['incidents', 'timeline', id, [...include].sort().join(',')] as const,
    sla: (id: string) => ['incidents', 'sla', id] as const,
    chain: (id: string) => ['incidents', 'chain', id] as const,
    // P-5.5. Investigation bookmarks, keyed by incident.
    bookmarks: (id: string) => ['incidents', 'bookmarks', id] as const,
  },
  // P-5.3. Evidence is immutable, so a fetched record never needs refetching — but a **download
  // target expires**, so it is keyed apart and never cached beyond its lifetime.
  evidence: {
    all: () => ['evidence'] as const,
    list: (params?: Record<string, unknown>) => ['evidence', 'list', params ?? {}] as const,
    detail: (id: string) => ['evidence', 'detail', id] as const,
    custody: (id: string) => ['evidence', 'custody', id] as const,
    // P-5.5. ⚠️ Keyed apart and short-lived: the session's signed URLs expire, so this is the one
    // evidence key that must NOT be treated as immutable.
    playback: (id: string) => ['evidence', 'playback', id] as const,
  },
  notifications: {
    all: () => ['notifications'] as const,
    list: (params?: Record<string, unknown>) => ['notifications', 'list', params ?? {}] as const,
  },
  // P-6.4. One key, because there is one call: the gateway assembles the whole report server-side.
  // ⚠️ `service()` was scaffolded here in Phase 0 and never used; a per-service key would mean the
  // browser fanning out to ten readiness probes, which is the thing the aggregate exists to avoid.
  health: {
    all: () => ['health'] as const,
    system: () => ['health', 'system'] as const,
    // P-8 Phase 3. Separate from `system()`: a different upstream, a different refresh budget, and
    // an operator watching a deploy should not invalidate one by refreshing the other.
    aiRuntime: () => ['health', 'ai-runtime'] as const,
    // P-8 Phase 5. Separate again: the bridge can be down while the runtime is fine, and an
    // operator must be able to see that without one page's failure emptying the other.
    eventBridge: () => ['health', 'event-bridge'] as const,
  },
  /*
   * P-8 Phase 6 — Camera Processing Assignment.
   *
   * ⚠️ `all()` is the invalidation root and every other key sits under it, because any accepted
   * action changes the list, the capacity and the history together: a camera moving to a runtime
   * changes its row, that runtime's occupancy and the audit trail in one write. Invalidating only
   * the list would leave a capacity page insisting there is room that has just been taken.
   *
   * ⚠️ `gate()` and `metrics()` are under the same root but come from a DIFFERENT service. They are
   * kept here so one invalidation refreshes both halves of the page; they are separate keys so a
   * media outage cannot blank the control-plane view.
   */
  assignment: {
    all: () => ['assignment'] as const,
    list: (filter: Record<string, unknown> = {}) => ['assignment', 'list', filter] as const,
    profiles: () => ['assignment', 'profiles'] as const,
    runtimes: () => ['assignment', 'runtimes'] as const,
    capacity: () => ['assignment', 'capacity'] as const,
    history: (params: Record<string, unknown> = {}) => ['assignment', 'history', params] as const,
    gate: () => ['assignment', 'gate'] as const,
    metrics: () => ['assignment', 'metrics'] as const,
  },
  /*
   * P-8 Phase 4 — object tracking. ⚠️ Separate keys rather than one, because the pages have
   * different refresh budgets and different failure modes: the live list moves at the frame rate,
   * the statistics do not, and a single track's detail must be able to 404 on its own without
   * emptying the list behind it.
   */
  tracking: {
    all: () => ['tracking'] as const,
    overview: () => ['tracking', 'overview'] as const,
    cameras: () => ['tracking', 'cameras'] as const,
    list: (params?: Record<string, unknown>) => ['tracking', 'list', params ?? {}] as const,
    detail: (trackId: string) => ['tracking', 'detail', trackId] as const,
  },
} as const;
