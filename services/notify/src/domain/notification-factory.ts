/**
 * Domain: pure construction + delivery-state transitions of a notification (one per channel per
 * incident). `buildNotification` inherits the incident's `correlationId` (rec 1 — the chain stays
 * unbroken) and sets `causationId` to the incident. The mark* helpers advance the delivery state:
 * `pending → sent → delivered|failed`, and (recipient) `delivered/sent → acked`. No I/O.
 */
import type {
  Incident,
  Notification,
  NotificationChannel,
  NotificationStatus,
} from '@vip/contracts';

export interface FactoryDeps {
  now: () => Date;
  newId: () => string;
}

/** Build a fresh `pending` notification for delivering `incident` over `channel`. */
export function buildNotification(
  incident: Incident,
  channel: NotificationChannel,
  deps: FactoryDeps,
): Notification {
  const at = deps.now().toISOString();
  return {
    id: deps.newId(),
    tenantId: incident.tenantId,
    incidentId: incident.id,
    channelId: channel.id,
    channelType: channel.type,
    status: 'pending',
    severity: incident.severity,
    title: incident.title,
    correlationId: incident.correlationId,
    causationId: incident.id,
    attempts: 0,
    createdAt: at,
    updatedAt: at,
  };
}

/** Handed to the transport — one attempt made. */
export function markSent(n: Notification, now: () => Date): Notification {
  const at = now().toISOString();
  return { ...n, status: 'sent', attempts: n.attempts + 1, sentAt: at, updatedAt: at };
}

/** Transport confirmed delivery. */
export function markDelivered(n: Notification, now: () => Date): Notification {
  const at = now().toISOString();
  return { ...n, status: 'delivered', deliveredAt: at, updatedAt: at };
}

/** Delivery failed (attempts exhausted for this pass). */
export function markFailed(n: Notification, error: string, now: () => Date): Notification {
  const at = now().toISOString();
  return { ...n, status: 'failed', failedAt: at, lastError: error, updatedAt: at };
}

/** A recipient acknowledged the notification. */
export function markAcked(n: Notification, by: string | undefined, now: () => Date): Notification {
  const at = now().toISOString();
  const acked: Notification = { ...n, status: 'acked', ackedAt: at, updatedAt: at };
  if (by !== undefined && by !== '') acked.ackedBy = by;
  return acked;
}

/**
 * The statuses an acknowledgement may move a delivery **out of**.
 *
 * ⚠️ One expression of the rule, in the one place that owns it. The application layer needs the same
 * rule in a form the database can enforce — the acknowledgement is decided by the write's filter,
 * because two operators can reach for one alert at the same moment — and two expressions of a state
 * transition are one edit away from disagreeing. The disagreement would surface as a race nobody
 * could reproduce.
 */
export const ACKNOWLEDGEABLE: readonly NotificationStatus[] = ['sent', 'delivered'];

/** A notification can be acknowledged only once it has been sent/delivered (not pending/failed). */
export function canAck(n: Notification): boolean {
  return ACKNOWLEDGEABLE.includes(n.status);
}
