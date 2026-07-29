/**
 * Application: publishes notification delivery signals onto the backbone
 * (`t.{tenant}.notification.{kind}` — sent|delivered|failed|acked) with the full Notification as the
 * payload. The workflow context (and analytics/connectors) may consume these; the msgId encodes
 * `{tenant}:{id}:{status}` so a redelivery collapses. A no-op publisher is used in tests without a bus.
 */
import type { Notification } from '@vip/contracts';
import { type EventBus, notificationSubject } from '@vip/messaging';

export interface NotificationPublisher {
  publish(notification: Notification): Promise<void>;
}

const STATUS_TO_KIND: Record<string, string> = {
  sent: 'sent',
  delivered: 'delivered',
  failed: 'failed',
  acked: 'acked',
};

export class BusNotificationPublisher implements NotificationPublisher {
  constructor(private readonly bus: EventBus) {}

  async publish(notification: Notification): Promise<void> {
    const kind = STATUS_TO_KIND[notification.status];
    if (!kind) return; // pending has no signal
    await this.bus.publish(notificationSubject(notification.tenantId, kind), notification, {
      msgId: `${notification.tenantId}:${notification.id}:${notification.status}`,
    });
  }
}

export const NoopNotificationPublisher: NotificationPublisher = {
  async publish() {
    /* no-op */
  },
};
