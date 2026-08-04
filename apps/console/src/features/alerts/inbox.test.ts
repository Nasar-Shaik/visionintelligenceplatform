/**
 * The inbox derivation (P-6.5) — grouping the delivery log into things an operator has to deal with.
 *
 * ⚠️ These are the assertions that keep a *queue* from decaying back into a *list*. Every one of them
 * is about a claim the screen makes on an operator's attention: how many things are waiting, which
 * of them anybody has taken, and what the screen must never quietly fold together.
 */
import { describe, expect, it } from 'vitest';
import type { Notification } from '@vip/contracts';
import { ackableDeliveries, groupIntoInbox, inboxCounts } from './inbox';

const base: Notification = {
  id: 'ntf-1',
  tenantId: 'tnt_acme',
  incidentId: 'inc-1',
  channelId: 'ch-app',
  channelType: 'in-app',
  status: 'delivered',
  severity: 'high',
  title: 'Person detected after hours',
  correlationId: 'corr-1',
  causationId: 'inc-1',
  attempts: 1,
  createdAt: '2026-07-29T11:00:00.000Z',
  updatedAt: '2026-07-29T11:00:00.000Z',
};
const delivery = (over: Partial<Notification>): Notification => ({ ...base, ...over });

describe('groupIntoInbox', () => {
  /**
   * ⚠️ The whole point of the milestone. One incident that fanned out to three channels is **one**
   * thing to deal with; listing it three times is what teaches an operator to skim the screen that
   * exists to stop them skimming.
   */
  it('one incident on three channels is one thing to deal with', () => {
    const entries = groupIntoInbox([
      delivery({ id: 'a', channelId: 'ch-app', channelType: 'in-app' }),
      delivery({ id: 'b', channelId: 'ch-hook', channelType: 'webhook' }),
      delivery({ id: 'c', channelId: 'ch-hook2', channelType: 'webhook' }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.deliveries).toHaveLength(3);
    // ⚠️ And the per-channel records survive: the delivery log is demoted, never discarded.
    expect(entries[0]?.deliveries.map((d) => d.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('separate incidents stay separate', () => {
    const entries = groupIntoInbox([
      delivery({ id: 'a', incidentId: 'inc-1' }),
      delivery({ id: 'b', incidentId: 'inc-2', createdAt: '2026-07-29T12:00:00.000Z' }),
    ]);
    expect(entries.map((e) => e.incidentId)).toEqual(['inc-2', 'inc-1']);
  });

  /**
   * ⚠️ Ordering is by **time, not severity**. Floating criticals to the top would bury a
   * medium-severity intrusion under an hour-old critical somebody is already working, and an
   * operator would have no way to tell whether the list was chronological.
   */
  it('orders by time, not by severity', () => {
    const entries = groupIntoInbox([
      delivery({
        id: 'a',
        incidentId: 'old-critical',
        severity: 'critical',
        createdAt: '2026-07-29T09:00:00.000Z',
      }),
      delivery({
        id: 'b',
        incidentId: 'new-medium',
        severity: 'medium',
        createdAt: '2026-07-29T11:00:00.000Z',
      }),
    ]);
    expect(entries.map((e) => e.incidentId)).toEqual(['new-medium', 'old-critical']);
  });

  it('an acknowledgement on any channel means a human took the incident', () => {
    const entries = groupIntoInbox([
      delivery({
        id: 'a',
        channelType: 'in-app',
        status: 'acked',
        ackedBy: 'sam',
        ackedAt: '2026-07-29T11:05:00.000Z',
      }),
      delivery({ id: 'b', channelType: 'webhook', status: 'delivered' }),
    ]);
    expect(entries[0]?.acknowledged).toBe(true);
    expect(entries[0]?.ackedBy).toBe('sam');
  });

  /**
   * ⚠️ **The two questions this screen must never collapse.** Acknowledging an incident says a human
   * took it; it says nothing about whether the customer's own system was ever told. Folding the
   * delivery failure into the acknowledgement would hide it behind an operator's action.
   */
  it('a failed delivery stays visible on an acknowledged incident', () => {
    const entries = groupIntoInbox([
      delivery({ id: 'a', channelType: 'in-app', status: 'acked', ackedBy: 'sam' }),
      delivery({
        id: 'b',
        channelType: 'webhook',
        status: 'failed',
        lastError: 'connect ECONNREFUSED',
      }),
    ]);

    expect(entries[0]?.acknowledged).toBe(true);
    expect(entries[0]?.failed).toHaveLength(1);
    expect(entries[0]?.failed[0]?.lastError).toBe('connect ECONNREFUSED');
  });

  it('counts how many channels an alert actually reached', () => {
    const entries = groupIntoInbox([
      delivery({ id: 'a', status: 'delivered' }),
      delivery({ id: 'b', status: 'failed' }),
      delivery({ id: 'c', status: 'pending' }),
    ]);
    // ⚠️ `pending` has not reached anything yet, and `failed` never will.
    expect(entries[0]?.reached).toBe(1);
    expect(entries[0]?.deliveries).toHaveLength(3);
  });
});

describe('inboxCounts', () => {
  it('counts incidents waiting, not delivery records', () => {
    const entries = groupIntoInbox([
      delivery({ id: 'a', incidentId: 'inc-1', channelType: 'in-app' }),
      delivery({ id: 'b', incidentId: 'inc-1', channelType: 'webhook' }),
      delivery({ id: 'c', incidentId: 'inc-2', status: 'acked' }),
    ]);
    // ⚠️ Three delivery records, two incidents, one waiting. The badge counts the last of those.
    expect(inboxCounts(entries).needsAttention).toBe(1);
  });

  it('counts delivery failures apart from the queue', () => {
    const entries = groupIntoInbox([
      delivery({ id: 'a', incidentId: 'inc-1', status: 'acked' }),
      delivery({ id: 'b', incidentId: 'inc-1', status: 'failed' }),
    ]);
    const counts = inboxCounts(entries);
    // Nobody needs to act on the incident; somebody needs to fix the channel.
    expect(counts.needsAttention).toBe(0);
    expect(counts.withFailedDelivery).toBe(1);
  });

  it('separates critical alerts that are still waiting', () => {
    const entries = groupIntoInbox([
      delivery({ id: 'a', incidentId: 'inc-1', severity: 'critical' }),
      delivery({ id: 'b', incidentId: 'inc-2', severity: 'low' }),
      delivery({ id: 'c', incidentId: 'inc-3', severity: 'critical', status: 'acked' }),
    ]);
    expect(inboxCounts(entries).criticalWaiting).toBe(1);
  });
});

describe('ackableDeliveries', () => {
  /**
   * ⚠️ A `failed` delivery cannot be acknowledged — there was no recipient — and a `pending` one has
   * not been handed to a transport. Offering to acknowledge either would be offering to record that
   * somebody received something nobody sent.
   */
  it('offers only the deliveries a recipient could actually have received', () => {
    const [entry] = groupIntoInbox([
      delivery({ id: 'a', status: 'delivered' }),
      delivery({ id: 'b', status: 'sent' }),
      delivery({ id: 'c', status: 'failed' }),
      delivery({ id: 'd', status: 'pending' }),
      delivery({ id: 'e', status: 'acked' }),
    ]);
    expect(
      ackableDeliveries(entry!)
        .map((n) => n.id)
        .sort(),
    ).toEqual(['a', 'b']);
  });
});
