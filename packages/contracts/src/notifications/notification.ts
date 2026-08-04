/**
 * Notification contracts (Phase 1, P1-8 — Notification context / the "Alert Engine"). The Alert
 * Engine consumes **`incident.raised`** (an Incident contract — never the rule candidate, P1-8
 * Architect rec 3), selects the tenant's matching **channels**, and delivers a **notification** per
 * channel, recording a delivery log with an explicit delivery state and publishing
 * `notification.sent|delivered|failed|acked`.
 *
 * Phase-1 ships two deterministic, credential-free channel types: `in-app` (an inbox/log the UI
 * reads) and `webhook` (HTTP POST). Email/SMS/push providers are integration-only and deferred
 * (see TECH-DEBT). Every notification carries the incident's `correlationId`/`causationId` so the
 * end-to-end chain stays unbroken (rec 1). Ownership: docs/architecture/22-BOUNDED-CONTEXTS.md §12,
 * docs/architecture/23-SERVICE-OWNERSHIP.md (notify).
 */
import { z } from 'zod';
import { IsoDateTime, TenantId, Uuid } from '../common/primitives.js';
import { EventPriority } from '../events/priority.js';

/** Channel transport types shipped in Phase 1 (extensible via the `notification.channel` plugin). */
export const NotificationChannelType = z.enum(['in-app', 'webhook']);
export type NotificationChannelType = z.infer<typeof NotificationChannelType>;

/** Webhook channel configuration — an HTTPS endpoint the engine POSTs the notification to. */
export const WebhookChannelConfig = z.object({
  url: z.url(),
  /** Optional static headers (e.g. an auth token); never logged. */
  headers: z.record(z.string(), z.string()).optional(),
});
export type WebhookChannelConfig = z.infer<typeof WebhookChannelConfig>;

/** In-app channel configuration — delivered to the tenant's in-app inbox (no external transport). */
export const InAppChannelConfig = z.object({});
export type InAppChannelConfig = z.infer<typeof InAppChannelConfig>;

/** A configured delivery channel (owned by the Notification context). */
export const NotificationChannel = z.object({
  id: z.string().min(1),
  tenantId: TenantId,
  name: z.string().min(1).max(200),
  type: NotificationChannelType,
  /** Type-specific config (validated per-type by the service). */
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
  /** Only deliver incidents at or above this severity (default: all). */
  minSeverity: EventPriority.optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  createdBy: z.string().optional(),
});
export type NotificationChannel = z.infer<typeof NotificationChannel>;

export const CreateChannelInput = z.object({
  name: z.string().min(1).max(200),
  type: NotificationChannelType,
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
  minSeverity: EventPriority.optional(),
});
export type CreateChannelInput = z.infer<typeof CreateChannelInput>;

export const UpdateChannelInput = z.object({
  name: z.string().min(1).max(200).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  minSeverity: EventPriority.optional(),
});
export type UpdateChannelInput = z.infer<typeof UpdateChannelInput>;

/**
 * Delivery state of a single notification:
 *   `pending` → `sent` → `delivered` | `failed`, and (optionally) `delivered`/`sent` → `acked`.
 * `sent` = handed to the transport; `delivered` = transport confirmed (e.g. webhook 2xx);
 * `failed` = exhausted attempts; `acked` = a recipient acknowledged.
 */
export const NotificationStatus = z.enum(['pending', 'sent', 'delivered', 'failed', 'acked']);
export type NotificationStatus = z.infer<typeof NotificationStatus>;

/** A single notification delivery record (one per channel per incident). */
export const Notification = z.object({
  id: Uuid,
  tenantId: TenantId,
  incidentId: Uuid,
  channelId: z.string().min(1),
  channelType: NotificationChannelType,
  status: NotificationStatus,
  severity: EventPriority,
  title: z.string().min(1),
  /** Inherited from the incident — keeps the end-to-end chain intact (rec 1). */
  correlationId: z.string().min(1),
  /** The incident id that caused this notification (causation chain). */
  causationId: Uuid,
  attempts: z.number().int().min(0).default(0),
  lastError: z.string().optional(),
  sentAt: IsoDateTime.optional(),
  deliveredAt: IsoDateTime.optional(),
  failedAt: IsoDateTime.optional(),
  ackedBy: z.string().optional(),
  ackedAt: IsoDateTime.optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Notification = z.infer<typeof Notification>;

/** Recipient input to acknowledge a delivered notification. */
export const AckNotificationInput = z.object({ by: z.string().max(200).optional() });
export type AckNotificationInput = z.infer<typeof AckNotificationInput>;

/**
 * Cursor-paged delivery-log query (tenant-scoped).
 *
 * ### ⚠️ `acknowledged` exists because "not acked" is not a status
 *
 * `status` selects **one** state, and the question an operator's inbox asks is the complement of
 * one: *what has nobody dealt with yet* — which is `pending`, `sent`, `delivered` **and** `failed`,
 * everything except `acked`. Fetching all of them and filtering in the browser answers it for the
 * rows that happen to be loaded and silently wrongly for the rest, which is the kind of counting
 * that turns an unread badge into a lie.
 *
 * Additive and optional, so every caller that predates the inbox keeps working unchanged (P-6.5).
 * ⚠️ A `failed` delivery counts as **unacknowledged**: it reached nobody, so nobody can have dealt
 * with it, and it is the one row that most needs to be in front of someone.
 */
export const NotificationQuery = z.object({
  incidentId: Uuid.optional(),
  status: NotificationStatus.optional(),
  /** `false` ⇒ everything except `acked`. `true` ⇒ only `acked`. Omitted ⇒ no filter. */
  acknowledged: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type NotificationQuery = z.infer<typeof NotificationQuery>;

export const NotificationPage = z.object({
  items: z.array(Notification),
  nextCursor: z.string().optional(),
});
export type NotificationPage = z.infer<typeof NotificationPage>;
