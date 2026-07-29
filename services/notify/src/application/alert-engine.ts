/**
 * Application: the Alert Engine consumer. Subscribes to **`incident.raised`** (filter
 * `t.*.incident.raised` on the AUTOMATION stream) — Incident contracts only, never the rule candidate
 * (P1-8 Architect rec 3) — and fans each raised incident out to the tenant's matching channels:
 * build a notification → hand it to the channel transport → record the delivery outcome → publish
 * `notification.sent` then `notification.delivered|failed`.
 *
 * Loop-free by construction: it consumes `incident.raised` and publishes onto the distinct
 * `t.*.notification.>` root (NOTIFICATIONS stream), which it never consumes. Fail-closed: a message
 * that is not a valid `Incident` is dead-lettered (`term`). Idempotent: a redelivered incident does
 * not double-notify a channel it already reached (delivery-log guard).
 */
import { Incident } from '@vip/contracts';
import {
  ALL_INCIDENTS,
  ALL_INCIDENTS_RAISED,
  ALL_NOTIFICATIONS,
  ALL_RULE_MATCHES,
  AUTOMATION_STREAM,
  NOTIFICATIONS_STREAM,
  type BusMessage,
  type EventBus,
  type Subscription,
} from '@vip/messaging';
import { TenantScope } from '@vip/tenancy';
import { selectChannels } from '../domain/channel-selection.js';
import {
  buildNotification,
  markDelivered,
  markFailed,
  markSent,
} from '../domain/notification-factory.js';
import type { ChannelStore, NotificationStore } from './ports.js';
import type { ChannelSenderRegistry } from './channel-sender.js';
import { NoopNotificationPublisher, type NotificationPublisher } from './notification-publisher.js';
import type { NotificationMetrics } from './metrics.js';

export type LogFn = (level: 'info' | 'warn' | 'error', msg: string, fields?: object) => void;

export interface AlertEngineDeps {
  bus: EventBus;
  channels: ChannelStore;
  notifications: NotificationStore;
  senders: ChannelSenderRegistry;
  publisher?: NotificationPublisher;
  metrics?: NotificationMetrics;
  now?: () => Date;
  newId?: () => string;
  log?: LogFn;
  durable?: string;
}

export class AlertEngine {
  private readonly bus: EventBus;
  private readonly channels: ChannelStore;
  private readonly notifications: NotificationStore;
  private readonly senders: ChannelSenderRegistry;
  private readonly publisher: NotificationPublisher;
  private readonly metrics: NotificationMetrics | undefined;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: LogFn;
  private readonly durable: string;
  private sub?: Subscription;

  constructor(deps: AlertEngineDeps) {
    this.bus = deps.bus;
    this.channels = deps.channels;
    this.notifications = deps.notifications;
    this.senders = deps.senders;
    this.publisher = deps.publisher ?? NoopNotificationPublisher;
    this.metrics = deps.metrics;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? (() => {});
    this.durable = deps.durable ?? 'notify-alerts';
  }

  async start(): Promise<void> {
    // Input: raised incidents on the AUTOMATION stream. Output: notifications on their own stream.
    await this.bus.ensureStream(AUTOMATION_STREAM, [ALL_INCIDENTS, ALL_RULE_MATCHES]);
    await this.bus.ensureStream(NOTIFICATIONS_STREAM, [ALL_NOTIFICATIONS]);
    this.sub = await this.bus.subscribe(
      { stream: AUTOMATION_STREAM, durable: this.durable, filterSubject: ALL_INCIDENTS_RAISED },
      (msg) => this.onMessage(msg),
    );
  }

  async stop(): Promise<void> {
    await this.sub?.stop();
  }

  async onMessage(msg: BusMessage): Promise<void> {
    let raw: unknown;
    try {
      raw = msg.json();
    } catch {
      this.metrics?.incidentsDeadLettered.inc();
      msg.term();
      return;
    }
    const parsed = Incident.safeParse(raw);
    if (!parsed.success) {
      this.metrics?.incidentsDeadLettered.inc();
      this.log('warn', 'dead-lettering: not a valid Incident', {
        subject: msg.subject,
        issue: parsed.error.issues[0]?.message,
      });
      msg.term();
      return;
    }
    this.metrics?.incidentsConsumed.inc();
    try {
      await this.fanOut(parsed.data);
      msg.ack();
    } catch (err) {
      this.log('error', 'alert fan-out failed; will redeliver', {
        subject: msg.subject,
        err: err instanceof Error ? err.message : String(err),
      });
      msg.nak();
    }
  }

  /** Deliver a raised incident to every matching channel (idempotent per incident+channel). */
  async fanOut(incident: Incident): Promise<void> {
    const endTimer = this.metrics?.deliveryDuration.startTimer();
    const scope = TenantScope.fromTenantId(incident.tenantId);
    const enabled = await this.channels.listEnabled(scope);
    const selected = selectChannels(enabled, incident.severity);

    for (const channel of selected) {
      // Idempotency — a redelivered incident.raised must not double-notify the same channel.
      if (await this.notifications.existsForIncidentChannel(scope, incident.id, channel.id)) {
        continue;
      }
      let notification = buildNotification(incident, channel, { now: this.now, newId: this.newId });
      await this.notifications.insert(scope, notification);

      const sender = this.senders.senderFor(channel.type);
      if (!sender) {
        notification = markFailed(
          notification,
          `no sender for channel type '${channel.type}'`,
          this.now,
        );
        await this.notifications.replace(scope, notification);
        this.metrics?.notificationsFailed.inc({ channel_type: channel.type });
        await this.publisher.publish(notification);
        continue;
      }

      // sent — handed to the transport.
      notification = markSent(notification, this.now);
      await this.notifications.replace(scope, notification);
      this.metrics?.notificationsSent.inc({ channel_type: channel.type });
      await this.publisher.publish(notification);

      const outcome = await sender.send(channel, notification);
      notification = outcome.ok
        ? markDelivered(notification, this.now)
        : markFailed(notification, outcome.error ?? 'delivery failed', this.now);
      await this.notifications.replace(scope, notification);
      if (outcome.ok) {
        this.metrics?.notificationsDelivered.inc({ channel_type: channel.type });
        this.log('info', 'notification delivered', {
          incidentId: incident.id,
          channelId: channel.id,
          correlationId: incident.correlationId,
        });
      } else {
        this.metrics?.notificationsFailed.inc({ channel_type: channel.type });
      }
      await this.publisher.publish(notification);
    }
    endTimer?.();
  }
}
