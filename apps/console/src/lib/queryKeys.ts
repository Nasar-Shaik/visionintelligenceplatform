/**
 * Centralised TanStack Query keys — the one place cache keys are defined so
 * invalidation stays consistent across features (state strategy §11).
 * Each feature adds its namespace here rather than inlining string arrays.
 */
export const queryKeys = {
  auth: {
    me: () => ['auth', 'me'] as const,
  },
  cameras: {
    all: () => ['cameras'] as const,
    list: (params?: Record<string, unknown>) => ['cameras', 'list', params ?? {}] as const,
    detail: (id: string) => ['cameras', 'detail', id] as const,
  },
  events: {
    all: () => ['events'] as const,
    list: (params?: Record<string, unknown>) => ['events', 'list', params ?? {}] as const,
  },
  rules: {
    all: () => ['rules'] as const,
    list: (params?: Record<string, unknown>) => ['rules', 'list', params ?? {}] as const,
    detail: (id: string) => ['rules', 'detail', id] as const,
  },
  incidents: {
    all: () => ['incidents'] as const,
    list: (params?: Record<string, unknown>) => ['incidents', 'list', params ?? {}] as const,
    detail: (id: string) => ['incidents', 'detail', id] as const,
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
