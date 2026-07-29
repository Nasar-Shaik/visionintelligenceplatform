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

  async ack(scope: TenantScope, id: string, input: AckNotificationInput): Promise<Notification> {
    const current = await this.get(scope, id);
    if (!canAck(current)) {
      throw conflict(`cannot acknowledge a notification in status '${current.status}'`);
    }
    const acked = markAcked(current, input.by, this.now);
    await this.store.replace(scope, acked);
    this.metrics?.notificationsAcked.inc();
    await this.publisher.publish(acked);
    return acked;
  }
}
