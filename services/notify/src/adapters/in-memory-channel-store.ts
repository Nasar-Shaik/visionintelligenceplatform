/**
 * A DB-free `ChannelStore` for unit tests and local wiring. Same tenant scoping as the Mongo adapter,
 * sharing the domain factory so channel CRUD is provable without a database.
 */
import type { CreateChannelInput, NotificationChannel, UpdateChannelInput } from '@vip/contracts';
import { TenancyError, type TenantScope } from '@vip/tenancy';
import { applyChannelUpdate, newChannel } from '../domain/channel-factory.js';
import type { ChannelStore } from '../application/ports.js';

export interface InMemoryChannelStoreDeps {
  now?: () => Date;
  newId?: () => string;
}

export class InMemoryChannelStore implements ChannelStore {
  private readonly channels: NotificationChannel[] = [];
  private readonly now: () => Date;
  private readonly newId: () => string;
  private seq = 0;

  constructor(deps: InMemoryChannelStoreDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => `ch_${++this.seq}`);
  }

  private owned(scope: TenantScope, c: NotificationChannel): boolean {
    return c.tenantId === scope.tenantId;
  }

  async create(
    scope: TenantScope,
    input: CreateChannelInput,
    actor?: string,
  ): Promise<NotificationChannel> {
    const channel = newChannel(scope.tenantId, input, { now: this.now, newId: this.newId }, actor);
    this.channels.push(channel);
    return channel;
  }

  async get(scope: TenantScope, id: string): Promise<NotificationChannel | null> {
    return this.channels.find((c) => c.id === id && this.owned(scope, c)) ?? null;
  }

  async list(scope: TenantScope): Promise<NotificationChannel[]> {
    return this.channels
      .filter((c) => this.owned(scope, c))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async listEnabled(scope: TenantScope): Promise<NotificationChannel[]> {
    return (await this.list(scope)).filter((c) => c.enabled);
  }

  async update(
    scope: TenantScope,
    id: string,
    patch: UpdateChannelInput,
    _actor?: string,
  ): Promise<NotificationChannel | null> {
    const idx = this.channels.findIndex((c) => c.id === id && this.owned(scope, c));
    if (idx === -1) return null;
    const updated = applyChannelUpdate(this.channels[idx]!, patch, this.now);
    if (updated.tenantId !== scope.tenantId) throw new TenancyError('cross-tenant write refused');
    this.channels[idx] = updated;
    return updated;
  }

  async remove(scope: TenantScope, id: string): Promise<boolean> {
    const idx = this.channels.findIndex((c) => c.id === id && this.owned(scope, c));
    if (idx === -1) return false;
    this.channels.splice(idx, 1);
    return true;
  }
}
