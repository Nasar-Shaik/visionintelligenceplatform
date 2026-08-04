import type { EventPriority, Notification } from '@vip/contracts';

/**
 * The operator's inbox, derived from the delivery log (P-6.5).
 *
 * ### ⚠️ A delivery log is not an inbox, and the difference is who is asking
 *
 * The delivery log answers an engineering question — *did the webhook POST succeed?* — and it
 * answers it one row per channel per incident. An operator arriving at a screen is asking a
 * different question: *what needs me?* One incident that fanned out to three channels is **one**
 * thing to deal with, not three, and a screen that lists it three times is a screen that trains
 * people to skim.
 *
 * So the log is grouped by incident here. The per-channel records are not discarded — they hang
 * underneath the entry, because "the webhook to the customer's SOC never fired" is still something
 * somebody has to know.
 *
 * ### ⚠️ Two different questions, kept apart
 *
 * - **Has anyone dealt with this?** — {@link InboxEntry.acknowledged}. One acknowledgement on any
 *   channel means a human saw the incident and took it. This is the operator's queue.
 * - **Did every channel actually deliver?** — {@link InboxEntry.failed}. A failed webhook is an
 *   *administrator's* problem and it stays visible whether or not an operator acknowledged the
 *   alert, because acknowledging an incident says nothing about whether the customer's own system
 *   was told.
 *
 * Collapsing the two would mean either hiding delivery failures behind an operator's acknowledgement
 * or leaving handled incidents in the queue forever because a webhook is misconfigured. Both are
 * ways of making a queue that nobody trusts.
 *
 * ### Grouping is complete for everything loaded
 *
 * The Alert Engine writes every channel's delivery for one incident in the same pass, so they arrive
 * adjacent in a time-ordered page. Grouping runs over the **accumulated** pages of the infinite
 * query rather than one page, so an incident split across a page boundary is re-joined as soon as
 * the next page loads — the count never double-counts, it only becomes more complete.
 */
export interface InboxEntry {
  incidentId: string;
  title: string;
  severity: EventPriority;
  /** The most recent moment anything happened for this incident. Drives the ordering. */
  at: string;
  /** Every channel's delivery record, newest first. The log, kept rather than thrown away. */
  deliveries: Notification[];
  /** Deliveries that reached their transport (`delivered` or `acked`). */
  reached: number;
  /** Deliveries that exhausted their attempts. ⚠️ Visible regardless of acknowledgement. */
  failed: Notification[];
  /** True once **any** channel's delivery has been acknowledged: a human took this incident. */
  acknowledged: boolean;
  ackedBy?: string;
  ackedAt?: string;
}

const RANK: Record<EventPriority, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** When something happened for a delivery: the latest of its timestamps. */
function momentOf(n: Notification): string {
  return n.ackedAt ?? n.failedAt ?? n.deliveredAt ?? n.sentAt ?? n.createdAt;
}

/**
 * Group a flat delivery log into inbox entries, newest first.
 *
 * ⚠️ Ordering is by **time, not severity**. An inbox that floated critical alerts to the top would
 * silently bury a medium-severity intrusion under an hour-old critical that somebody is already
 * working — and an operator would have no way to tell whether the list was chronological. Severity
 * is a filter and a colour here, never a reordering.
 */
export function groupIntoInbox(deliveries: readonly Notification[]): InboxEntry[] {
  const byIncident = new Map<string, Notification[]>();
  for (const delivery of deliveries) {
    const bucket = byIncident.get(delivery.incidentId);
    if (bucket) bucket.push(delivery);
    else byIncident.set(delivery.incidentId, [delivery]);
  }

  const entries = [...byIncident.entries()].map(([incidentId, group]) => {
    const sorted = [...group].sort((a, b) => momentOf(b).localeCompare(momentOf(a)));
    const acked = sorted.find((n) => n.status === 'acked');
    const first = sorted[0]!;
    const entry: InboxEntry = {
      incidentId,
      /* Every delivery for one incident carries the same title and severity; the newest wins ties. */
      title: first.title,
      severity: first.severity,
      at: momentOf(first),
      deliveries: sorted,
      reached: sorted.filter((n) => n.status === 'delivered' || n.status === 'acked').length,
      failed: sorted.filter((n) => n.status === 'failed'),
      acknowledged: acked !== undefined,
    };
    if (acked?.ackedBy !== undefined) entry.ackedBy = acked.ackedBy;
    if (acked?.ackedAt !== undefined) entry.ackedAt = acked.ackedAt;
    return entry;
  });

  return entries.sort((a, b) => b.at.localeCompare(a.at) || RANK[a.severity] - RANK[b.severity]);
}

/** The three numbers a shift handover actually needs. */
export interface InboxCounts {
  /** Incidents nobody has acknowledged. This is the number on the bell. */
  needsAttention: number;
  /** ⚠️ Counted separately: a delivery failure is an administrator's problem, not a queue item. */
  withFailedDelivery: number;
  /** Unacknowledged **and** critical — the subset that should not wait for a shift change. */
  criticalWaiting: number;
}

export function inboxCounts(entries: readonly InboxEntry[]): InboxCounts {
  return {
    needsAttention: entries.filter((e) => !e.acknowledged).length,
    withFailedDelivery: entries.filter((e) => e.failed.length > 0).length,
    criticalWaiting: entries.filter((e) => !e.acknowledged && e.severity === 'critical').length,
  };
}

/**
 * The deliveries an "acknowledge" on this entry would act on.
 *
 * ⚠️ Only the ones a recipient can actually acknowledge. A `failed` delivery cannot be acknowledged
 * — there was no recipient — and a `pending` one has not been handed to a transport yet. Acking the
 * entry therefore means "I have taken this incident", and it deliberately does **not** clear the
 * delivery failure sitting beside it.
 */
export function ackableDeliveries(entry: InboxEntry): Notification[] {
  return entry.deliveries.filter((n) => n.status === 'sent' || n.status === 'delivered');
}
