/**
 * Domain: pure channel selection. Given a raised incident's severity and a tenant's channels, decide
 * which channels should receive a notification: enabled, and (if the channel sets a `minSeverity`)
 * only when the incident is at or above it. No I/O. Severity urgency uses the shared
 * `EVENT_PRIORITY_RANK` (lower number = more urgent).
 */
import type { EventPriority, NotificationChannel } from '@vip/contracts';
import { EVENT_PRIORITY_RANK } from '@vip/contracts';

/** Is `severity` at or above the channel's `minSeverity` floor (or is there no floor)? */
export function meetsSeverity(channel: NotificationChannel, severity: EventPriority): boolean {
  if (channel.minSeverity === undefined) return true;
  return EVENT_PRIORITY_RANK[severity] <= EVENT_PRIORITY_RANK[channel.minSeverity];
}

/** The channels that should receive a notification for an incident of `severity`. */
export function selectChannels(
  channels: NotificationChannel[],
  severity: EventPriority,
): NotificationChannel[] {
  return channels.filter((c) => c.enabled && meetsSeverity(c, severity));
}
