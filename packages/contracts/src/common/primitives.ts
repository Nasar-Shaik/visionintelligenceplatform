/**
 * Reusable primitive schemas shared across all contracts.
 * These enforce the platform's canonical formats (see docs/reference/GLOSSARY.md).
 */
import { z } from 'zod';

/** Semantic version, e.g. "1.2.0" (contracts/capabilities/models are semver'd — Constitution §7). */
export const SemVer = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, 'must be semver (e.g. 1.2.0)');

/** ISO-8601 timestamp (Zod 4 top-level format API). */
export const IsoDateTime = z.iso.datetime({ offset: true });

/** UUID identifier (Zod 4 top-level format API). */
export const Uuid = z.uuid();

/**
 * Event type in the taxonomy `<domain>.<subject>.<predicate>` — lowercase, dot-separated,
 * kebab segments allowed (docs/architecture/09-EVENT-PLATFORM.md §1). e.g. "spatial.line.crossed".
 */
export const EventType = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/, 'must be <domain>.<subject>.<predicate>');

/** Capability id `<family>.<name>` (docs/architecture/05 §2). e.g. "perception.person-detection". */
export const CapabilityId = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be <family>.<name>');

/** Tenant identifier. Every record and operation carries one (Law 5). */
export const TenantId = z.string().min(1);

/** Confidence score in [0, 1]. */
export const Confidence = z.number().min(0).max(1);

/** Axis-aligned bounding box [x, y, width, height] in normalized [0,1] coordinates. */
export const BBox = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export type SemVer = z.infer<typeof SemVer>;
export type IsoDateTime = z.infer<typeof IsoDateTime>;
export type EventType = z.infer<typeof EventType>;
export type CapabilityId = z.infer<typeof CapabilityId>;
export type TenantId = z.infer<typeof TenantId>;
