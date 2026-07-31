/**
 * Real-time delivery contracts (P2-2 G-5) — the wire shape the gateway pushes to browser/SSE
 * clients over `GET /api/stream`. Deliberately DECOUPLED from `EventEnvelope`:
 *
 *   - The gateway carries domain events as an opaque `payload` (`z.unknown()`), so a future
 *     `EventEnvelope` schema change (a new field, a bumped `schemaVersion`) flows through to
 *     clients WITHOUT a `StreamEnvelope` change and without breaking existing realtime consumers
 *     (Architect G-5 rec 5). The transport frame evolves on its own `streamVersion` axis.
 *   - `id` is a gateway-assigned, per-tenant monotonic cursor (NOT the domain event id) — it is the
 *     SSE `id:` used by `Last-Event-ID` reconnect replay from the gateway's bounded ring buffer.
 *   - `priority` (Architect G-5 rec 1) lets the StreamHub shed LOW before MEDIUM before HIGH under
 *     queue saturation — critical alerts survive backpressure. It is transport-local, derived at the
 *     edge; it is not authored by producers.
 *
 * Grounds: docs/architecture/09-EVENT-PLATFORM.md (event backbone), 21-API-CONTRACTS.md,
 * docs/architecture/phase2/REALTIME_DELIVERY.md.
 */
import { z } from 'zod';
import { IsoDateTime, SemVer, TenantId } from '../common/primitives.js';

/**
 * The logical channels a client can subscribe to on a single multiplexed connection. Each maps to a
 * tenant-scoped subject family on the backbone (see the gateway's stream domain) and is gated by a
 * distinct read permission:
 *   - `incidents` → `t.{tenant}.incident.>`      (needs `incident:read`)
 *   - `alerts`    → `t.{tenant}.notification.>`  (needs `notification:read`)
 *   - `events`    → `t.{tenant}.event.>` (non-system) (needs `event:read`)
 *   - `system`    → `t.{tenant}.event.system.>`  (needs `camera:read`)
 */
export const StreamTopic = z.enum(['incidents', 'alerts', 'events', 'system']);
export type StreamTopic = z.infer<typeof StreamTopic>;

/**
 * Transport delivery priority (edge-derived). Under backpressure the StreamHub drops from the
 * bottom up: analytics/statistics first, incidents next, critical/safety/security last.
 */
export const StreamPriority = z.enum(['high', 'medium', 'low']);
export type StreamPriority = z.infer<typeof StreamPriority>;

/** Ordering helper (lower = more urgent) for the hub's drop policy. */
export const STREAM_PRIORITY_RANK: Record<StreamPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * One real-time frame delivered as an SSE `data:` line. The envelope is intentionally minimal and
 * stable; everything domain-specific rides in `payload` untyped so the envelope never has to change
 * as domain contracts evolve.
 */
export const StreamEnvelope = z.object({
  /** SSE `id:` — gateway-assigned, per-tenant monotonic cursor for `Last-Event-ID` replay. */
  id: z.string().min(1),
  /** Frame format version — evolves independently of `EventEnvelope`/`schemaVersion` (G-5 rec 5). */
  streamVersion: SemVer.default('1.0.0'),
  /** The channel this frame belongs to (also the SSE `event:` name). */
  topic: StreamTopic,
  /** Owning tenant (always the connection's own tenant — cross-tenant delivery is impossible). */
  tenantId: TenantId,
  /** The domain event/subject leaf, e.g. `incident.raised`, `notification.sent`, `event.<type>`. */
  type: z.string().min(1),
  /** Edge-derived transport priority (drop order under saturation). */
  priority: StreamPriority,
  /** When the underlying domain event occurred (best-effort; falls back to receipt time). */
  occurredAt: IsoDateTime,
  /** Opaque domain payload (the raw event body) — NOT validated here, so it stays version-safe. */
  payload: z.unknown(),
});
export type StreamEnvelope = z.infer<typeof StreamEnvelope>;

/** Out-of-band control frames (SSE `event: <type>`), distinct from domain `data:` frames. */
export const StreamControlType = z.enum(['ready', 'heartbeat', 'error']);
export type StreamControlType = z.infer<typeof StreamControlType>;

/**
 * A control frame. `ready` is sent once on connect (echoes the granted topics + resume cursor);
 * `heartbeat` is a periodic keepalive; `error` precedes a server-initiated close (e.g. token
 * expiry). Clients ignore unknown control types (forward-compatible).
 */
export const StreamControl = z.object({
  type: StreamControlType,
  at: IsoDateTime,
  /** Topics actually granted (requested ∩ permitted) — present on `ready`. */
  topics: z.array(StreamTopic).optional(),
  /** The last cursor the client can resume from — present on `ready`. */
  cursor: z.string().optional(),
  /** Human-readable detail — present on `error`. */
  detail: z.string().optional(),
});
export type StreamControl = z.infer<typeof StreamControl>;
