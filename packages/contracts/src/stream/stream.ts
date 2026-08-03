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

// ---------------------------------------------------------------------------------------------
// P-5.3 rec 16 — real-time workspace updates, reserved.
// ---------------------------------------------------------------------------------------------

/**
 * Workspace-facing update kinds the realtime channel will carry. **Reserved: nothing publishes
 * these.**
 *
 * ### ⚠️ Why this extends SSE rather than reserving a WebSocket
 *
 * The review asked for a "WebSocket-ready architecture". The platform already has a working
 * realtime transport: `GET /api/stream`, SSE, multiplexed by `StreamTopic`, with a per-tenant
 * monotonic cursor and `Last-Event-ID` replay from a bounded ring buffer (P2-2 G-5). Adding a
 * second transport would mean two connection lifecycles, two backpressure policies, two auth paths
 * and two replay semantics — for updates that are **server→client only**.
 *
 * WebSocket earns its complexity when the client needs to *push*. Nothing here does: an operator's
 * actions are HTTP requests that must be authorised, versioned and audited individually, and
 * routing them over a socket would take them off the path where all of that happens.
 *
 * So what is reserved is the **vocabulary**, on the transport that exists. If a future feature
 * genuinely needs client→server streaming, that is a transport decision with its own ADR — and it
 * will consume these kinds rather than replace them.
 */
export const WorkspaceUpdateKind = z.enum([
  /** An incident this operator has open changed — re-fetch, never patch from the frame. */
  'incident-changed',
  /** Evidence was registered against an open incident. */
  'evidence-added',
  /** A playback session became resolvable (media materialised). */
  'playback-available',
  /** A background job moved. Carries the job id; progress is re-fetched. */
  'job-progress',
  /** A camera in view went offline or recovered. */
  'camera-status-changed',
  /** ⚠️ Reserved. No AI produces anything to finish. */
  'ai-completed',
]);
export type WorkspaceUpdateKind = z.infer<typeof WorkspaceUpdateKind>;

/**
 * ⚠️ **A notification that something changed — never the change itself.**
 *
 * The frame carries an id and a kind. The client re-fetches under its own permissions. Pushing the
 * changed record would put a copy of a business record on a channel whose subscription was
 * authorised once, at connect time, minutes or hours earlier — and an operator whose access is
 * revoked mid-session would keep receiving updates until they reconnected. Re-fetching re-checks.
 */
export const WorkspaceUpdate = z.object({
  kind: WorkspaceUpdateKind,
  /** What changed, so the client knows which query to invalidate. */
  entity: z.string().min(1).max(40),
  targetId: z.string().min(1).max(200),
  correlationId: z.string().min(1).optional(),
  at: IsoDateTime,
});
export type WorkspaceUpdate = z.infer<typeof WorkspaceUpdate>;
