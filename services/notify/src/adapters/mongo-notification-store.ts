/**
 * Adapter: `NotificationStore` (delivery log) over MongoDB via the @vip/tenancy `TenantRepository`.
 * `insert` maps a duplicate on the `(tenantId, incidentId, channelId)` index to a 409 (the idempotent
 * fan-out signal). `list` is newest-first keyset pagination.
 */
import type { Collection } from 'mongodb';
import type { Notification, NotificationPage, NotificationQuery } from '@vip/contracts';
import { TenantRepository, type TenantScope } from '@vip/tenancy';
import { conflict } from '../application/errors.js';
import type { NotificationStore } from '../application/ports.js';

export interface MongoNotificationStoreDeps {
  notifications: Collection<Notification>;
}

const STRIP = { projection: { _id: 0 } } as const;
const DUPLICATE_KEY = 11000;

function encodeCursor(n: Notification): string {
  return Buffer.from(`${n.createdAt}|${n.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    return createdAt && id ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

export class MongoNotificationStore implements NotificationStore {
  private readonly notifications: TenantRepository<Notification>;

  constructor(deps: MongoNotificationStoreDeps) {
    this.notifications = new TenantRepository<Notification>(deps.notifications);
  }

  async insert(scope: TenantScope, notification: Notification): Promise<void> {
    try {
      await this.notifications.insertOne(scope, notification as Omit<Notification, 'tenantId'>);
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: number }).code === DUPLICATE_KEY
      ) {
        throw conflict(`notification already exists for this incident+channel`);
      }
      throw err;
    }
  }

  async get(scope: TenantScope, id: string): Promise<Notification | null> {
    return this.notifications.collection.findOne(
      { tenantId: scope.tenantId, id } as never,
      STRIP,
    ) as Promise<Notification | null>;
  }

  async replace(scope: TenantScope, notification: Notification): Promise<boolean> {
    const matched = await this.notifications.updateOne(
      scope,
      { id: notification.id } as never,
      { $set: notification } as never,
    );
    return matched > 0;
  }

  async existsForIncidentChannel(
    scope: TenantScope,
    incidentId: string,
    channelId: string,
  ): Promise<boolean> {
    const found = await this.notifications.collection.findOne(
      { tenantId: scope.tenantId, incidentId, channelId } as never,
      { projection: { _id: 1 } },
    );
    return found !== null;
  }

  async list(scope: TenantScope, query: NotificationQuery): Promise<NotificationPage> {
    const filter: Record<string, unknown> = { tenantId: scope.tenantId };
    if (query.incidentId !== undefined) filter['incidentId'] = query.incidentId;
    if (query.status !== undefined) filter['status'] = query.status;
    /*
     * ⚠️ The inbox filter. `acknowledged: false` is the *complement* of one status, not a status —
     * pending, sent, delivered and failed all mean "nobody has dealt with this". A `failed` delivery
     * counts as unacknowledged deliberately: it reached nobody, so nobody can have acted on it.
     */
    if (query.acknowledged !== undefined) {
      filter['status'] = query.acknowledged ? 'acked' : { $ne: 'acked' };
    }
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      if (c) {
        filter['$or'] = [
          { createdAt: { $lt: c.createdAt } },
          { createdAt: c.createdAt, id: { $lt: c.id } },
        ];
      }
    }
    const rows = (await this.notifications.collection
      .find(filter as never, STRIP)
      .sort({ createdAt: -1, id: -1 })
      .limit(query.limit + 1)
      .toArray()) as Notification[];

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return hasMore && items.length > 0
      ? { items, nextCursor: encodeCursor(items[items.length - 1]!) }
      : { items };
  }
}
