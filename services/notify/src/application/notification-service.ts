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
import { ACKNOWLEDGEABLE, canAck, markAcked } from '../domain/notification-factory.js';
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
   *
   * ### ⚠️ The transition is decided by the write, not before it
   *
   * This used to read the record, check `canAck`, and write it back. Two operators seeing the same
   * alert land both passed the check before either wrote, and both were told they had the incident.
   * Measured against the deployment: twelve operators acknowledging one alert produced **two to four
   * winners in nine rounds out of twelve** — while six operators looked perfectly correct, which is
   * why a single passing run means nothing here.
   *
   * In a security product that is not a cosmetic race. Two people each believe they own an alert, so
   * each assumes the other is not on it; the queue clears; the record names whoever wrote last, who
   * may not be the person who acted. So the acceptable statuses go into the **filter** and the
   * database adjudicates. The pre-read survives only to tell a loser *why* — and that answer is
   * re-read from storage rather than assumed.
   */
  async ack(
    scope: TenantScope,
    id: string,
    input: AckNotificationInput,
    actor?: string,
  ): Promise<Notification> {
    const current = await this.get(scope, id);
    if (!canAck(current)) throw this.refusal(current);
    void input;
    const acked = markAcked(current, actor, this.now);
    const won = await this.store.replaceIfStatus(scope, acked, ACKNOWLEDGEABLE);
    if (!won) {
      /* Somebody else got there between the read and the write. Say what is true now. */
      throw this.refusal(await this.get(scope, id));
    }
    this.metrics?.notificationsAcked.inc();
    await this.publisher.publish(acked);
    return acked;
  }

  /**
   * Why an acknowledgement was refused, in the words the console puts in front of the operator.
   *
   * ### ⚠️ One sentence, whichever way they lost
   *
   * There are two ways to lose the same race, and they used to say different things. Read the record
   * *after* the winner's write and the pre-read refuses you with `cannot acknowledge a notification
   * in status 'acked'`; lose by a few milliseconds and the write refuses you with *"this alert was
   * acknowledged by sam@… a moment ago"*. Same event, same operator, two different messages —
   * and the one an operator was **more** likely to see was the one naming an internal status.
   * Caught by reading the screenshots this pass produced, not by a test.
   */
  private refusal(current: Notification): Error {
    if (current.status === 'acked' && current.ackedBy !== undefined) {
      return conflict(`this alert was acknowledged by ${current.ackedBy} a moment ago`);
    }
    if (current.status === 'failed') {
      return conflict('this alert never reached anyone, so there is nothing to acknowledge');
    }
    if (current.status === 'pending') {
      return conflict('this alert has not been sent yet');
    }
    return conflict(`cannot acknowledge a notification in status '${current.status}'`);
  }
}
