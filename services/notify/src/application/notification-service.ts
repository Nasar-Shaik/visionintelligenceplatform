/**
 * Application: delivery-log read + recipient acknowledgement. `list` is the tenant-scoped delivery
 * log; `ack` moves a delivered/sent notification to `acked` (a 409 if it is pending/failed/already
 * acked), persists it, publishes `notification.acked`, and records a metric. Ack is the "with-ack"
 * completion of the camera→alert vertical.
 */
import type {
  AckNotificationInput,
  Notification,
  NotificationPage,
  NotificationQuery,
} from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import { canAck, markAcked } from '../domain/notification-factory.js';
import { conflict, notFound } from './errors.js';
import type { NotificationStore } from './ports.js';
import { NoopNotificationPublisher, type NotificationPublisher } from './notification-publisher.js';
import type { NotificationMetrics } from './metrics.js';

export interface NotificationServiceDeps {
  store: NotificationStore;
  publisher?: NotificationPublisher;
  metrics?: NotificationMetrics;
  now?: () => Date;
}

export class NotificationService {
  private readonly store: NotificationStore;
  private readonly publisher: NotificationPublisher;
  private metrics: NotificationMetrics | undefined;
  private readonly now: () => Date;

  constructor(deps: NotificationServiceDeps) {
    this.store = deps.store;
    this.publisher = deps.publisher ?? NoopNotificationPublisher;
    this.metrics = deps.metrics;
    this.now = deps.now ?? (() => new Date());
  }

  useMetrics(metrics: NotificationMetrics): void {
    this.metrics = metrics;
  }

  list(scope: TenantScope, query: NotificationQuery): Promise<NotificationPage> {
    return this.store.list(scope, query);
  }

  async get(scope: TenantScope, id: string): Promise<Notification> {
    const notification = await this.store.get(scope, id);
    if (!notification) throw notFound(`notification ${id} not found`);
    return notification;
  }

  /**
   * Acknowledge a delivery — *somebody has this incident*.
   *
   * ### ⚠️ The acknowledger is the authenticated principal, and `input.by` is deliberately ignored
   *
   * `ackedBy` used to come **entirely from the request body**. Two consequences, both found in P-6.5
   * by looking at what the inbox actually rendered: the console sent nothing, so every
   * acknowledgement it made was **unattributed** — a queue nobody signs is a queue nobody owns — and
   * a caller who did send it could name **anyone**, so the record of who took a security alert was
   * whatever the caller typed.
   *
   * The field stays in the contract (removing it would break every existing caller) and is no longer
   * honoured. ⚠️ An audit field a caller can choose is not an audit field.
   */
  async ack(
    scope: TenantScope,
    id: string,
    input: AckNotificationInput,
    actor?: string,
  ): Promise<Notification> {
    const current = await this.get(scope, id);
    if (!canAck(current)) {
      throw conflict(`cannot acknowledge a notification in status '${current.status}'`);
    }
    void input;
    const acked = markAcked(current, actor, this.now);
    await this.store.replace(scope, acked);
    this.metrics?.notificationsAcked.inc();
    await this.publisher.publish(acked);
    return acked;
  }
}
