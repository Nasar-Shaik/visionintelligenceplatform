/**
 * Tenant-partitioned subject taxonomy for the backbone (docs/architecture/09 §1, ADR-0016).
 * Every subject is rooted at `t.{tenantId}.…` so JetStream partitions by tenant and a consumer
 * physically cannot subscribe across tenants without asking for another tenant's token. The
 * tenant id is validated to a single NATS-safe token (fail-closed, Law 5): a `.`/`*`/`>`/space in
 * a tenant id would silently widen or break the subject, so it is rejected up front.
 *
 * Taxonomy (event types + capability ids are already dotted-kebab, so they form the trailing tokens):
 *   - capability outputs (detections): `t.{tenantId}.capability.output.{capabilityId}`
 *   - persisted events:                `t.{tenantId}.event.{eventType}`
 */
import { MessagingError } from './errors.js';

/** A tenant id usable as ONE subject token: alphanumerics, `_`, `-` only (no dot/wildcard/space). */
const TENANT_TOKEN = /^[A-Za-z0-9_-]+$/;

export const TENANT_ROOT = 't';
export const CAPABILITY_OUTPUT_PREFIX = 'capability.output';
export const EVENT_PREFIX = 'event';
export const INCIDENT_PREFIX = 'incident';
export const RULE_PREFIX = 'rule';
export const NOTIFICATION_PREFIX = 'notification';

/** JetStream stream capturing every tenant's capability outputs (detections). */
export const CAPABILITY_OUTPUT_STREAM = 'CAPABILITY_OUTPUT';
/** JetStream stream capturing every tenant's persisted/domain events. */
export const EVENTS_STREAM = 'EVENTS';
/**
 * JetStream stream capturing automation outputs — rule matches (`t.*.rule.>`) AND the full incident
 * lifecycle (`t.*.incident.>`: `candidate` from the rule engine + `raised|acknowledged|resolved|
 * closed` from the workflow context). Consumers filter to the exact subject they own, so a producer
 * never re-consumes its own output (e.g. workflow filters `incident.candidate`, publishes the rest).
 */
export const AUTOMATION_STREAM = 'AUTOMATION';
/** JetStream stream capturing every tenant's notification deliveries (`t.*.notification.>`). */
export const NOTIFICATIONS_STREAM = 'NOTIFICATIONS';

/** Validate + return a tenant id safe to embed as a single subject token, else throw (fail-closed). */
export function assertTenantToken(tenantId: string): string {
  if (typeof tenantId !== 'string' || !TENANT_TOKEN.test(tenantId)) {
    throw new MessagingError(
      `unsafe tenantId for subject (must match ${TENANT_TOKEN}): ${JSON.stringify(tenantId)}`,
    );
  }
  return tenantId;
}

/** `t.{tenantId}` — the per-tenant subject root. */
export function tenantRoot(tenantId: string): string {
  return `${TENANT_ROOT}.${assertTenantToken(tenantId)}`;
}

/** Subject a capability publishes a detection result to: `t.{tenantId}.capability.output.{capabilityId}`. */
export function capabilityOutputSubject(tenantId: string, capabilityId: string): string {
  return `${tenantRoot(tenantId)}.${CAPABILITY_OUTPUT_PREFIX}.${capabilityId}`;
}

/** Subject a persisted event is published on: `t.{tenantId}.event.{eventType}`. */
export function eventSubject(tenantId: string, eventType: string): string {
  return `${tenantRoot(tenantId)}.${EVENT_PREFIX}.${eventType}`;
}

/** Subject a rule-engine incident candidate is published on: `t.{tenantId}.incident.candidate`. */
export function incidentCandidateSubject(tenantId: string): string {
  return `${tenantRoot(tenantId)}.${INCIDENT_PREFIX}.candidate`;
}

/**
 * Subject an incident lifecycle transition is published on: `t.{tenantId}.incident.{status}`
 * (`raised` | `acknowledged` | `resolved` | `closed`). The workflow context publishes these; the
 * Alert Engine consumes only `incident.raised` (P1-8 Architect rec 3).
 */
export function incidentLifecycleSubject(tenantId: string, status: string): string {
  return `${tenantRoot(tenantId)}.${INCIDENT_PREFIX}.${assertTenantToken(status)}`;
}

/** Subject a raised incident is published on: `t.{tenantId}.incident.raised`. */
export function incidentRaisedSubject(tenantId: string): string {
  return incidentLifecycleSubject(tenantId, 'raised');
}

/** Subject a notification delivery signal is published on: `t.{tenantId}.notification.{kind}`. */
export function notificationSubject(tenantId: string, kind: string): string {
  return `${tenantRoot(tenantId)}.${NOTIFICATION_PREFIX}.${assertTenantToken(kind)}`;
}

/** Subject a rule-match audit signal is published on: `t.{tenantId}.rule.matched`. */
export function ruleMatchedSubject(tenantId: string): string {
  return `${tenantRoot(tenantId)}.${RULE_PREFIX}.matched`;
}

/** Wildcard for consuming ALL tenants' capability outputs: `t.*.capability.output.>`. */
export const ALL_CAPABILITY_OUTPUTS = `${TENANT_ROOT}.*.${CAPABILITY_OUTPUT_PREFIX}.>`;
/** Wildcard for consuming ALL tenants' persisted events: `t.*.event.>`. */
export const ALL_EVENTS = `${TENANT_ROOT}.*.${EVENT_PREFIX}.>`;
/** Wildcard capturing ALL tenants' incident subjects (candidate + lifecycle): `t.*.incident.>`. */
export const ALL_INCIDENTS = `${TENANT_ROOT}.*.${INCIDENT_PREFIX}.>`;
/** Filter for consuming ONLY incident candidates (the workflow promoter): `t.*.incident.candidate`. */
export const ALL_INCIDENT_CANDIDATES = `${TENANT_ROOT}.*.${INCIDENT_PREFIX}.candidate`;
/** Filter for consuming ONLY raised incidents (the Alert Engine): `t.*.incident.raised`. */
export const ALL_INCIDENTS_RAISED = `${TENANT_ROOT}.*.${INCIDENT_PREFIX}.raised`;
/** Wildcard for consuming ALL tenants' rule-match signals: `t.*.rule.>`. */
export const ALL_RULE_MATCHES = `${TENANT_ROOT}.*.${RULE_PREFIX}.>`;
/** Wildcard for consuming ALL tenants' notification signals: `t.*.notification.>`. */
export const ALL_NOTIFICATIONS = `${TENANT_ROOT}.*.${NOTIFICATION_PREFIX}.>`;

/**
 * Extract the tenant id from a `t.{tenantId}.…` subject, or `undefined` if the subject is not
 * tenant-rooted. Consumers cross-check this against the message body's `tenantId` (defence in depth).
 */
export function tenantIdFromSubject(subject: string): string | undefined {
  const parts = subject.split('.');
  if (parts.length < 2 || parts[0] !== TENANT_ROOT) return undefined;
  const token = parts[1];
  return token && TENANT_TOKEN.test(token) ? token : undefined;
}

/**
 * Does a concrete subject match a NATS subject pattern (`*` = one token, `>` = one-or-more trailing
 * tokens)? Used by the in-memory bus to mirror JetStream routing in tests/local.
 */
export function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split('.');
  const s = subject.split('.');
  for (let i = 0; i < p.length; i++) {
    const tok = p[i];
    if (tok === '>') return s.length >= i + 1; // matches the rest (one or more tokens)
    if (i >= s.length) return false;
    if (tok === '*') continue; // matches exactly one token
    if (tok !== s[i]) return false;
  }
  return s.length === p.length;
}
