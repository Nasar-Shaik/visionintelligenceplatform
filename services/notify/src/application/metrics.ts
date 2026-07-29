/**
 * Alert-engine metrics — observability for the Notification context. Registered on the service's
 * Prometheus registry (the same one `/metrics` serves) so incident-consumption, per-channel delivery
 * outcomes, and acks are scrapeable. A small injected collaborator (a no-op instance is fine in unit
 * tests that don't assert metrics).
 */
import { Counter, Histogram, type Registry } from 'prom-client';

export class NotificationMetrics {
  readonly incidentsConsumed: Counter<string>;
  readonly incidentsDeadLettered: Counter<string>;
  readonly notificationsSent: Counter<string>;
  readonly notificationsDelivered: Counter<string>;
  readonly notificationsFailed: Counter<string>;
  readonly notificationsAcked: Counter<string>;
  readonly deliveryDuration: Histogram<string>;

  constructor(registry: Registry) {
    this.incidentsConsumed = new Counter({
      name: 'notify_incidents_consumed_total',
      help: 'Raised incidents received from the automation backbone',
      registers: [registry],
    });
    this.incidentsDeadLettered = new Counter({
      name: 'notify_incidents_dead_lettered_total',
      help: 'Incidents dead-lettered (invalid contract — fail-closed)',
      registers: [registry],
    });
    this.notificationsSent = new Counter({
      name: 'notify_notifications_sent_total',
      help: 'Notifications handed to a channel transport',
      labelNames: ['channel_type'],
      registers: [registry],
    });
    this.notificationsDelivered = new Counter({
      name: 'notify_notifications_delivered_total',
      help: 'Notifications the transport confirmed delivered',
      labelNames: ['channel_type'],
      registers: [registry],
    });
    this.notificationsFailed = new Counter({
      name: 'notify_notifications_failed_total',
      help: 'Notifications that failed delivery',
      labelNames: ['channel_type'],
      registers: [registry],
    });
    this.notificationsAcked = new Counter({
      name: 'notify_notifications_acked_total',
      help: 'Notifications acknowledged by a recipient',
      registers: [registry],
    });
    this.deliveryDuration = new Histogram({
      name: 'notify_incident_fanout_duration_seconds',
      help: 'Time to fan one incident out to all its channels',
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [registry],
    });
  }
}
