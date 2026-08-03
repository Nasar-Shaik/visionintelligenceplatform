/**
 * Centralised TanStack Query keys — the one place cache keys are defined so
 * invalidation stays consistent across features (state strategy §11).
 * Each feature adds its namespace here rather than inlining string arrays.
 */
export const queryKeys = {
  auth: {
    me: () => ['auth', 'me'] as const,
  },
  // P-3. The estate. A move rewrites descendants and an archive cascades, so writes invalidate
  // `all()` rather than a node — the set of changed nodes is the traversal the server just did.
  organization: {
    all: () => ['organization'] as const,
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
  },
  // P-5.3. Evidence is immutable, so a fetched record never needs refetching — but a **download
  // target expires**, so it is keyed apart and never cached beyond its lifetime.
  evidence: {
    all: () => ['evidence'] as const,
    list: (params?: Record<string, unknown>) => ['evidence', 'list', params ?? {}] as const,
    detail: (id: string) => ['evidence', 'detail', id] as const,
    custody: (id: string) => ['evidence', 'custody', id] as const,
  },
  notifications: {
    all: () => ['notifications'] as const,
    list: (params?: Record<string, unknown>) => ['notifications', 'list', params ?? {}] as const,
  },
  health: {
    all: () => ['health'] as const,
    service: (service: string) => ['health', service] as const,
  },
} as const;
