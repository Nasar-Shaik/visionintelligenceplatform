/**
 * Application: notification-channel authoring use-cases (CRUD). Adds per-type **config validation**
 * (a webhook needs a valid URL; in-app takes no config) on top of the store — an invalid config is a
 * 400. Kept lean (the depth is in the alert engine, not channel CRUD).
 */
import {
  type CreateChannelInput,
  InAppChannelConfig,
  type NotificationChannel,
  type UpdateChannelInput,
  WebhookChannelConfig,
} from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import { badRequest, notFound } from './errors.js';
import type { ChannelStore } from './ports.js';

/** Validate the type-specific config, returning a normalized config or throwing a 400. */
function validateConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  if (type === 'webhook') {
    const parsed = WebhookChannelConfig.safeParse(config);
    if (!parsed.success) {
      throw badRequest(`webhook config: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    }
    return parsed.data as Record<string, unknown>;
  }
  // in-app: no config
  InAppChannelConfig.parse(config ?? {});
  return {};
}

export interface ChannelServiceDeps {
  store: ChannelStore;
}

export class ChannelService {
  private readonly store: ChannelStore;

  constructor(deps: ChannelServiceDeps) {
    this.store = deps.store;
  }

  create(
    scope: TenantScope,
    input: CreateChannelInput,
    actor?: string,
  ): Promise<NotificationChannel> {
    const config = validateConfig(input.type, input.config);
    return this.store.create(scope, { ...input, config }, actor);
  }

  async get(scope: TenantScope, id: string): Promise<NotificationChannel> {
    const channel = await this.store.get(scope, id);
    if (!channel) throw notFound(`channel ${id} not found`);
    return channel;
  }

  list(scope: TenantScope): Promise<NotificationChannel[]> {
    return this.store.list(scope);
  }

  async update(
    scope: TenantScope,
    id: string,
    patch: UpdateChannelInput,
    actor?: string,
  ): Promise<NotificationChannel> {
    if (patch.config !== undefined) {
      const existing = await this.get(scope, id);
      patch = { ...patch, config: validateConfig(existing.type, patch.config) };
    }
    const channel = await this.store.update(scope, id, patch, actor);
    if (!channel) throw notFound(`channel ${id} not found`);
    return channel;
  }

  async remove(scope: TenantScope, id: string): Promise<void> {
    const ok = await this.store.remove(scope, id);
    if (!ok) throw notFound(`channel ${id} not found`);
  }
}
