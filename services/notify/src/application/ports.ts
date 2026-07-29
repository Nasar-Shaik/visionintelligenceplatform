/**
 * Application ports — the persistence seams for the notify context. `ChannelStore` holds the tenant's
 * delivery channels; `NotificationStore` is the append-and-update delivery log. Concrete Mongo /
 * in-memory adapters are wired by the composition root. Every method is tenant-scoped structurally
 * (via @vip/tenancy).
 */
import type {
  CreateChannelInput,
  Notification,
  NotificationChannel,
  NotificationPage,
  NotificationQuery,
  UpdateChannelInput,
} from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';

export interface ChannelStore {
  create(
    scope: TenantScope,
    input: CreateChannelInput,
    actor?: string,
  ): Promise<NotificationChannel>;
  get(scope: TenantScope, id: string): Promise<NotificationChannel | null>;
  list(scope: TenantScope): Promise<NotificationChannel[]>;
  /** Channels the alert engine should consider (enabled) for a tenant. */
  listEnabled(scope: TenantScope): Promise<NotificationChannel[]>;
  update(
    scope: TenantScope,
    id: string,
    patch: UpdateChannelInput,
    actor?: string,
  ): Promise<NotificationChannel | null>;
  remove(scope: TenantScope, id: string): Promise<boolean>;
}

export interface NotificationStore {
  insert(scope: TenantScope, notification: Notification): Promise<void>;
  get(scope: TenantScope, id: string): Promise<Notification | null>;
  /** Persist an updated delivery record (last-writer-wins; the alert engine owns each record). */
  replace(scope: TenantScope, notification: Notification): Promise<boolean>;
  list(scope: TenantScope, query: NotificationQuery): Promise<NotificationPage>;
  /** Idempotency: has this incident already been delivered to this channel? */
  existsForIncidentChannel(
    scope: TenantScope,
    incidentId: string,
    channelId: string,
  ): Promise<boolean>;
}
