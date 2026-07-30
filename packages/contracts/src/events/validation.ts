/**
 * Event catalog validation helpers (P2-2 G-3) — the query/validation surface over the catalog data.
 * Rule/workflow authors, the inference runtime, and connectors use these to validate event types.
 * The core lookups (`lookupEvent`/`isKnownEventType`) live in [catalog.ts](catalog.ts) for backward
 * compatibility; this module adds assertion + format helpers on top (acyclic: it imports the catalog,
 * never the other way round).
 */
import { EventType } from '../common/primitives.js';
import { isKnownEventType } from './catalog.js';

/** Assert a type is registered; throws with a clear message otherwise. */
export function assertKnownEventType(type: string): void {
  if (!isKnownEventType(type)) {
    throw new Error(`unknown event type: "${type}" (not in the canonical catalog)`);
  }
}

/** Whether a string is a syntactically valid `<domain>.<subject>.<predicate>` event type. */
export function isValidEventTypeFormat(type: string): boolean {
  return EventType.safeParse(type).success;
}
