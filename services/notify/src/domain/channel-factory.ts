/**
 * Domain: pure construction + update of notification channels (shared by the Mongo + in-memory
 * stores). Channels are simple config records (no version history in Phase 1 — unlike rules). The
 * per-type config shape is validated by the service before this runs. No I/O.
 */
import type { CreateChannelInput, NotificationChannel, UpdateChannelInput } from '@vip/contracts';

export interface FactoryDeps {
  now: () => Date;
  newId: () => string;
}

export function newChannel(
  tenantId: string,
  input: CreateChannelInput,
  deps: FactoryDeps,
  actor?: string,
): NotificationChannel {
  const at = deps.now().toISOString();
  const channel: NotificationChannel = {
    id: deps.newId(),
    tenantId,
    name: input.name,
    type: input.type,
    config: input.config,
    enabled: input.enabled,
    createdAt: at,
    updatedAt: at,
  };
  if (input.minSeverity !== undefined) channel.minSeverity = input.minSeverity;
  if (actor !== undefined) channel.createdBy = actor;
  return channel;
}

export function applyChannelUpdate(
  existing: NotificationChannel,
  patch: UpdateChannelInput,
  now: () => Date,
): NotificationChannel {
  const channel: NotificationChannel = { ...existing, updatedAt: now().toISOString() };
  if (patch.name !== undefined) channel.name = patch.name;
  if (patch.config !== undefined) channel.config = patch.config;
  if (patch.enabled !== undefined) channel.enabled = patch.enabled;
  if (patch.minSeverity !== undefined) channel.minSeverity = patch.minSeverity;
  return channel;
}
