import type { EventPriority } from '@vip/contracts';

/**
 * Single mapping from the contract `EventPriority` enum to design-system severity
 * tokens (DESIGN_SYSTEM.md §2). Drives badges, left-borders, and row tints everywhere,
 * so severity presentation is defined once. Severity is never colour-only — always
 * paired with a label (accessibility §8).
 */
export const SEVERITY_ORDER: readonly EventPriority[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
];

export interface SeverityTokens {
  /** Text/dot/left-border colour utility class fragment (e.g. `sev-critical`). */
  readonly token: string;
  /** Human label. */
  readonly label: string;
}

const SEVERITY: Record<EventPriority, SeverityTokens> = {
  critical: { token: 'sev-critical', label: 'Critical' },
  high: { token: 'sev-high', label: 'High' },
  medium: { token: 'sev-medium', label: 'Medium' },
  low: { token: 'sev-low', label: 'Low' },
  info: { token: 'sev-info', label: 'Info' },
};

export function severityTokens(priority: EventPriority): SeverityTokens {
  return SEVERITY[priority];
}

/** Rank for comparisons/sorts — higher = more urgent. */
export function severityRank(priority: EventPriority): number {
  return SEVERITY_ORDER.length - SEVERITY_ORDER.indexOf(priority);
}
