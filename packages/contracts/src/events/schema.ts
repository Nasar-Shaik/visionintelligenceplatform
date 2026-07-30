/**
 * Event-catalog entry schema (P2-2 G-3) — the shape of one catalog record, split out from the
 * catalog data ([catalog.ts](catalog.ts)) so the schema and the entries evolve independently. The
 * catalog is the single source of truth binding an event `type` to its category, default priority,
 * PII classification, and typical producer.
 */
import { z } from 'zod';
import { EventType, CapabilityId } from '../common/primitives.js';
import { EventPriority } from './priority.js';
import { EventCategory } from './category.js';

/** PII classification for governance/policy handling (docs/architecture/15, 28). */
export const PiiClass = z.enum(['none', 'low', 'high']);
export type PiiClass = z.infer<typeof PiiClass>;

/** A catalog entry describing one event type. */
export const EventCatalogEntry = z.object({
  type: EventType,
  description: z.string(),
  /** Coarse classification for filtering/routing (rules, analytics) — stamped onto every envelope. */
  category: EventCategory,
  /** Capability family that typically produces it (informational). */
  producer: CapabilityId.optional(),
  defaultPriority: EventPriority,
  pii: PiiClass.default('none'),
});
export type EventCatalogEntry = z.infer<typeof EventCatalogEntry>;
