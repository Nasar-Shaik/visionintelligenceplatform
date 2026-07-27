/**
 * Event priority (docs/architecture/09-EVENT-PLATFORM.md §4). Drives queue routing,
 * notification latency budgets, retention, and UI surfacing. Safety-critical types default
 * to `critical` and get reserved processing lanes so load-shedding never starves them.
 */
import { z } from 'zod';

export const EventPriority = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type EventPriority = z.infer<typeof EventPriority>;

/** Ordering helper (lower number = more urgent) for schedulers/queues. */
export const EVENT_PRIORITY_RANK: Record<EventPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};
