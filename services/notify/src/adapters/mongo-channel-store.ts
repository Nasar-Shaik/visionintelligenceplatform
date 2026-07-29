/**
 * Adapter: `ChannelStore` over MongoDB, routed through the @vip/tenancy `TenantRepository` so every
 * read/write is tenant-scoped structurally. Shares the domain factory with the in-memory store.
 */
import type { Collection } from 'mongodb';
import type { CreateChannelInput, NotificationChannel, UpdateChannelInput } from '@vip/contracts';
import { TenantRepository, type TenantScope } from '@vip/tenancy';
import { applyChannelUpdate, newChannel } from '../domain/channel-factory.js';
import type { ChannelStore } from '../application/ports.js';

export interface MongoChannelStoreDeps {
  channels: Collection<NotificationChannel>;
  now?: () => Date;
  newId?: () => string;
}

const STRIP = { projection: { _id: 0 } } as const;

export class MongoChannelStore implements ChannelStore {
  private readonly channels: TenantRepository<NotificationChannel>;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: MongoChannelStoreDeps) {
    this.channels = new TenantRepository<NotificationChannel>(deps.channels);
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  async create(
    scope: TenantScope,
    input: CreateChannelInput,
    actor?: string,
  ): Promise<NotificationChannel> {
    const channel = newChannel(scope.tenantId, input, { now: this.now, newId: this.newId }, actor);
    await this.channels.insertOne(scope, channel as Omit<NotificationChannel, 'tenantId'>);
    return channel;
  }

  async get(scope: TenantScope, id: string): Promise<NotificationChannel | null> {
    return this.channels.collection.findOne(
      { tenantId: scope.tenantId, id } as never,
      STRIP,
    ) as Promise<NotificationChannel | null>;
  }

  async list(scope: TenantScope): Promise<NotificationChannel[]> {
    return this.channels.collection
      .find({ tenantId: scope.tenantId } as never, STRIP)
      .sort({ id: 1 })
      .toArray() as Promise<NotificationChannel[]>;
  }

  async listEnabled(scope: TenantScope): Promise<NotificationChannel[]> {
    return this.channels.collection
      .find({ tenantId: scope.tenantId, enabled: true } as never, STRIP)
      .sort({ id: 1 })
      .toArray() as Promise<NotificationChannel[]>;
  }

  async update(
    scope: TenantScope,
    id: string,
    patch: UpdateChannelInput,
    _actor?: string,
  ): Promise<NotificationChannel | null> {
    const existing = await this.get(scope, id);
    if (!existing) return null;
    const updated = applyChannelUpdate(existing, patch, this.now);
    const matched = await this.channels.updateOne(
      scope,
      { id } as never,
      { $set: updated } as never,
    );
    return matched === 0 ? null : updated;
  }

  async remove(scope: TenantScope, id: string): Promise<boolean> {
    const deleted = await this.channels.deleteOne(scope, { id } as never);
    return deleted > 0;
  }
}
