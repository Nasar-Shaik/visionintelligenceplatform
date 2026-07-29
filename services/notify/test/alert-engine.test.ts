import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryEventBus,
  incidentRaisedSubject,
  notificationSubject,
  ALL_NOTIFICATIONS,
  type BusMessage,
} from '@vip/messaging';
import { TenantScope } from '@vip/tenancy';
import type { Notification } from '@vip/contracts';
import { AlertEngine } from '../src/application/alert-engine.js';
import {
  ChannelSenderRegistry,
  InAppSender,
  type ChannelSender,
  type DeliveryOutcome,
} from '../src/application/channel-sender.js';
import { BusNotificationPublisher } from '../src/application/notification-publisher.js';
import { InMemoryChannelStore } from '../src/adapters/in-memory-channel-store.js';
import { InMemoryNotificationStore } from '../src/adapters/in-memory-notification-store.js';
import { inAppChannelInput, raisedIncident, webhookChannelInput } from './helpers.js';

let bus: InMemoryEventBus;
let channels: InMemoryChannelStore;
let notifications: InMemoryNotificationStore;
let webhookOutcome: DeliveryOutcome;
const scopeA = TenantScope.fromTenantId('tnt_a');

/** A webhook sender whose outcome the test controls (no real HTTP). */
const fakeWebhook: ChannelSender = {
  async send(): Promise<DeliveryOutcome> {
    return webhookOutcome;
  },
};

async function startEngine(): Promise<void> {
  let n = 0;
  const engine = new AlertEngine({
    bus,
    channels,
    notifications,
    senders: new ChannelSenderRegistry()
      .register('in-app', new InAppSender())
      .register('webhook', fakeWebhook),
    publisher: new BusNotificationPublisher(bus),
    now: () => new Date('2026-07-29T22:00:01.000Z'),
    newId: () => `ntf_${++n}`,
  });
  await engine.start();
}

function collect(): Notification[] {
  const out: Notification[] = [];
  void bus.subscribe(
    { stream: 'NOTIFICATIONS', durable: 'probe', filterSubject: ALL_NOTIFICATIONS },
    (m: BusMessage) => {
      out.push(m.json());
      m.ack();
    },
  );
  return out;
}

async function raise(incident = raisedIncident()): Promise<void> {
  await bus.publish(incidentRaisedSubject(incident.tenantId), incident);
}

beforeEach(() => {
  bus = new InMemoryEventBus();
  channels = new InMemoryChannelStore();
  notifications = new InMemoryNotificationStore();
  webhookOutcome = { ok: true };
});

describe('AlertEngine — incident.raised → delivered notification', () => {
  it('delivers to an enabled in-app channel and publishes sent + delivered (acceptance)', async () => {
    await channels.create(scopeA, inAppChannelInput());
    const out = collect();
    await startEngine();
    await raise();

    const statuses = out.map((n) => n.status);
    expect(statuses).toContain('sent');
    expect(statuses).toContain('delivered');
    const delivered = out.find((n) => n.status === 'delivered')!;
    expect(delivered).toMatchObject({
      severity: 'critical',
      title: 'High-confidence person',
      correlationId: 'corr-abc', // inherited from the incident (rec 1)
      causationId: '11111111-1111-4111-8111-111111111111',
      channelType: 'in-app',
    });
  });

  it('honours a channel minSeverity floor (high incident, critical-only channel → no delivery)', async () => {
    await channels.create(scopeA, inAppChannelInput({ minSeverity: 'critical' }));
    const out = collect();
    await startEngine();
    await raise(raisedIncident({ severity: 'high' }));

    expect(out).toHaveLength(0);
  });

  it('records a failed delivery when the webhook transport fails', async () => {
    webhookOutcome = { ok: false, error: 'webhook responded 500' };
    await channels.create(scopeA, webhookChannelInput());
    const out = collect();
    await startEngine();
    await raise();

    const failed = out.find((n) => n.status === 'failed');
    expect(failed).toBeDefined();
    expect(failed?.lastError).toBe('webhook responded 500');
  });

  it('is idempotent — a redelivered incident does not double-notify a channel', async () => {
    await channels.create(scopeA, inAppChannelInput());
    await startEngine();
    await raise();
    await raise(); // same incident id

    const page = await notifications.list(scopeA, { limit: 50 });
    expect(page.items).toHaveLength(1);
  });

  it('dead-letters a message that is not a valid Incident (fail-closed)', async () => {
    await channels.create(scopeA, inAppChannelInput());
    const out = collect();
    await startEngine();
    await bus.publish(incidentRaisedSubject('tnt_a'), { not: 'an incident' });

    expect(out).toHaveLength(0);
    expect(bus.delivered.some((d) => d.disposition === 'term')).toBe(true);
  });

  it('never consumes its own notification output (loop-free)', async () => {
    await channels.create(scopeA, inAppChannelInput());
    await startEngine();
    // publishing a notification signal must not trigger any delivery
    await bus.publish(notificationSubject('tnt_a', 'delivered'), { anything: true });

    const page = await notifications.list(scopeA, { limit: 50 });
    expect(page.items).toHaveLength(0);
  });
});
