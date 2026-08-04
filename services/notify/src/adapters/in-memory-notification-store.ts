/**
 * A DB-free `NotificationStore` (delivery log) for unit tests and local wiring. Same tenant scoping,
 * per-(incident,channel) idempotency, and newest-first keyset pagination as the Mongo adapter.
 */
import type {
  Notification,
  NotificationPage,
  NotificationQuery,
  NotificationStatus,
} from '@vip/contracts';
import { TenancyError, type TenantScope } from '@vip/tenancy';
import { conflict } from '../application/errors.js';
import type { NotificationStore } from '../application/ports.js';

export class InMemoryNotificationStore implements NotificationStore {
  private readonly log: Notification[] = [];

  private owned(scope: TenantScope, n: Notification): boolean {
    return n.tenantId === scope.tenantId;
  }

  async insert(scope: TenantScope, notification: Notification): Promise<void> {
    if (notification.tenantId !== scope.tenantId) {
      throw new TenancyError('cross-tenant write refused');
    }
    if (this.log.some((n) => this.owned(scope, n) && n.id === notification.id)) {
      throw conflict(`notification ${notification.id} already exists`);
    }
    this.log.push(notification);
  }

  async get(scope: TenantScope, id: string): Promise<Notification | null> {
    return this.log.find((n) => this.owned(scope, n) && n.id === id) ?? null;
  }

  async replace(scope: TenantScope, notification: Notification): Promise<boolean> {
    const idx = this.log.findIndex((n) => this.owned(scope, n) && n.id === notification.id);
    if (idx === -1) return false;
    this.log[idx] = notification;
    return true;
  }

  /**
   * ⚠️ Faithful to the Mongo adapter's *contract*, and unable to reproduce its *race*. Nothing
   * interleaves between the find and the assignment here, so a read-compare-write in the service
   * would look correct against this store — which is precisely how the defect this method exists to
   * fix survived. The race belongs to `docs/review/p6/inbox-concurrency.mjs`, against real MongoDB
   * on real sockets; what a unit test can pin is the refusal, and it does.
   */
  async replaceIfStatus(
    scope: TenantScope,
    notification: Notification,
    expected: readonly NotificationStatus[],
  ): Promise<boolean> {
    const idx = this.log.findIndex((n) => this.owned(scope, n) && n.id === notification.id);
    if (idx === -1) return false;
    if (!expected.includes(this.log[idx]!.status)) return false;
    this.log[idx] = notification;
    return true;
  }

  async existsForIncidentChannel(
    scope: TenantScope,
    incidentId: string,
    channelId: string,
  ): Promise<boolean> {
    return this.log.some(
      (n) => this.owned(scope, n) && n.incidentId === incidentId && n.channelId === channelId,
    );
  }

  async list(scope: TenantScope, query: NotificationQuery): Promise<NotificationPage> {
    const rows = this.log
      .filter(
        (n) =>
          this.owned(scope, n) &&
          (query.incidentId === undefined || n.incidentId === query.incidentId) &&
          (query.status === undefined || n.status === query.status) &&
          (query.acknowledged === undefined ||
            (query.acknowledged ? n.status === 'acked' : n.status !== 'acked')),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));

    let start = 0;
    if (query.cursor) {
      const idx = rows.findIndex((r) => r.id === query.cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const items = rows.slice(start, start + query.limit);
    const hasMore = start + query.limit < rows.length;
    return hasMore && items.length > 0
      ? { items, nextCursor: items[items.length - 1]!.id }
      : { items };
  }
}
