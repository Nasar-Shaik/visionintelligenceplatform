/**
 * Real-time stream domain (P2-2 G-5) — PURE, transport-agnostic rules the StreamHub applies:
 *   - which backbone subject families feed which client topic,
 *   - how a delivered subject classifies to exactly one topic,
 *   - which read permission gates each topic,
 *   - how a domain event maps to a transport priority (drop order under backpressure),
 *   - the connection lifecycle state model.
 *
 * No I/O, no Fastify, no NATS client here — just data + functions, so it is trivially unit-tested
 * and reused by any future transport adapter (SSE now; WebSocket/gRPC later, Architect rec 5).
 */
import {
  AUTOMATION_STREAM,
  EVENTS_STREAM,
  NOTIFICATIONS_STREAM,
  EVENT_PREFIX,
  INCIDENT_PREFIX,
  NOTIFICATION_PREFIX,
  tenantRoot,
} from '@vip/messaging';
import type { StreamPriority, StreamTopic } from '@vip/contracts';

/**
 * An upstream subscription source: one durable consumer per (tenant, stream) that the hub attaches
 * when a tenant has ≥1 connection wanting any of the source's `topics`. `events` and `system` share
 * the EVENTS stream, so a single EVENTS subscription feeds both (classified per message) — never two
 * overlapping consumers.
 */
export interface StreamSource {
  readonly key: string;
  readonly stream: string;
  /** The tenant-scoped subject filter for this source's consumer. */
  filterSubject(tenantId: string): string;
  /** Topics this source can yield (after per-message classification). */
  readonly topics: readonly StreamTopic[];
}

export const STREAM_SOURCES: readonly StreamSource[] = [
  {
    key: 'incidents',
    stream: AUTOMATION_STREAM,
    filterSubject: (t) => `${tenantRoot(t)}.${INCIDENT_PREFIX}.>`,
    topics: ['incidents'],
  },
  {
    key: 'alerts',
    stream: NOTIFICATIONS_STREAM,
    filterSubject: (t) => `${tenantRoot(t)}.${NOTIFICATION_PREFIX}.>`,
    topics: ['alerts'],
  },
  {
    key: 'events',
    stream: EVENTS_STREAM,
    filterSubject: (t) => `${tenantRoot(t)}.${EVENT_PREFIX}.>`,
    topics: ['events', 'system'],
  },
];

/** The read permission each topic requires (deny-by-default; checked via @vip/permissions). */
export const TOPIC_PERMISSION: Record<StreamTopic, string> = {
  incidents: 'incident:read',
  alerts: 'notification:read',
  events: 'event:read',
  system: 'camera:read',
};

/** Every source needed to serve the given set of topics (deduped). */
export function sourcesForTopics(topics: readonly StreamTopic[]): StreamSource[] {
  const want = new Set(topics);
  return STREAM_SOURCES.filter((s) => s.topics.some((t) => want.has(t)));
}

/**
 * Classify a concrete delivered subject (`t.{tenant}.{family}.{leaf...}`) to exactly one client
 * topic, or `undefined` if it should NOT be streamed to clients. Notably:
 *   - `incident.candidate` is internal (rule→workflow) → not streamed; only lifecycle transitions are.
 *   - `event.system.*` → `system`; any other `event.*` → `events`.
 */
export function subjectToTopic(subject: string): StreamTopic | undefined {
  const parts = subject.split('.');
  // parts: [ 't', <tenant>, <family>, <leaf...> ]
  const family = parts[2];
  const leaf = parts[3];
  if (family === INCIDENT_PREFIX) {
    return leaf === 'candidate' ? undefined : 'incidents';
  }
  if (family === NOTIFICATION_PREFIX) return 'alerts';
  if (family === EVENT_PREFIX) {
    return leaf === 'system' ? 'system' : 'events';
  }
  return undefined;
}

/** The domain `type` label carried on the frame — the subject minus its `t.{tenant}.` prefix. */
export function typeFromSubject(subject: string): string {
  const parts = subject.split('.');
  return parts.slice(2).join('.') || subject;
}

// --- Priority classification (Architect rec 1) --------------------------------------------------
// HIGH: critical alerts, camera offline, fire/smoke/weapon, security/safety events → survive drops.
// MEDIUM: incident lifecycle, ordinary perception events.
// LOW: analytics/statistics/dashboard counters → shed first (and the future coalescing seam, rec 6).

const HIGH_SEVERITIES = new Set(['critical', 'high']);
const HIGH_TYPE_HINTS = ['fire', 'smoke', 'weapon', 'camera.offline', 'stream.lost', '.failed'];
const LOW_CATEGORIES = new Set(['analytics']);
const LOW_TYPE_HINTS = ['people.count', 'queue.length', 'occupancy', 'statistic'];

/** Read a string field from an opaque payload without trusting its shape. */
function field(payload: unknown, key: string): string | undefined {
  if (payload && typeof payload === 'object' && key in payload) {
    const v = (payload as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

/**
 * Derive the transport priority for a frame from its topic, type, and (opaque) payload. Pure and
 * defensive — never throws on an unexpected payload; unknowns default to MEDIUM. This is the single
 * seam a future coalescing/throttling policy (rec 6) would extend, without touching transport code.
 */
export function classifyPriority(
  topic: StreamTopic,
  type: string,
  payload: unknown,
): StreamPriority {
  const severity = field(payload, 'severity') ?? field(payload, 'priority');
  const category = field(payload, 'category');
  const t = type.toLowerCase();

  if (severity && HIGH_SEVERITIES.has(severity)) return 'high';
  if (category === 'security' || category === 'safety') return 'high';
  if (HIGH_TYPE_HINTS.some((h) => t.includes(h))) return 'high';

  if (topic === 'system') return 'low'; // routine status (offline/failed already caught above)
  if (category && LOW_CATEGORIES.has(category)) return 'low';
  if (LOW_TYPE_HINTS.some((h) => t.includes(h))) return 'low';

  return 'medium';
}

// --- Connection lifecycle (Architect rec 1) -----------------------------------------------------

/**
 * The lifecycle of a single stream connection. The transport route drives Connecting→Authenticating
 * →Authorized (edge auth + topic resolution); the hub drives Subscribed→Streaming and periodic
 * Heartbeat; transport/client events drive Reconnecting/Closed. Documented in
 * docs/architecture/phase2/REALTIME_DELIVERY.md §Connection lifecycle.
 */
export type ConnectionState =
  'connecting' | 'authenticating' | 'authorized' | 'subscribed' | 'streaming' | 'closed';

export const CONNECTION_STATES: readonly ConnectionState[] = [
  'connecting',
  'authenticating',
  'authorized',
  'subscribed',
  'streaming',
  'closed',
];
