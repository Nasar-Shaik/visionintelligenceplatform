/**
 * @vip/contracts — the single source of integration truth.
 * Versioned Zod schemas + inferred types for events, capabilities, config, and API envelopes.
 * Types are consumed directly; JSON Schema / OpenAPI are generated from these (see scripts/).
 *
 * Architecture: docs/architecture/00 §7 (versioning), 05 (capabilities), 06 §6 (config),
 * 09 (events), 21 (API). Contract-first is Law 4.
 */

// common
export * from './common/primitives.js';
export * from './common/tenant-context.js';
export * from './common/api-envelope.js';

// tenant + org hierarchy (P1-1)
export * from './tenant/tenant.js';

// auth: users, tokens, principal (P1-2)
export * from './auth/auth.js';

// camera inventory (P1-3)
export * from './camera/camera.js';

// media / ingestion (P1-4)
export * from './media/media.js';

// evidence (P2-2 G-4)
export * from './evidence/evidence.js';

// perception / inference (P1-6)
export * from './perception/perception.js';

// tracking + zones (AI-2)
export * from './tracking/tracking.js';

// inference platform: model registry, jobs, runtime metrics, pipeline (P2-2 G-3)
export * from './inference/inference.js';

// events
export * from './events/priority.js';
export * from './events/category.js';
export * from './events/envelope.js';
export * from './events/event-types.js';
export * from './events/schema.js';
export * from './events/catalog.js';
export * from './events/validation.js';
export * from './events/query.js';

// rules + incident candidates (P1-7)
export * from './rules/rules.js';

// incidents — workflow lifecycle (P1-8)
export * from './incidents/incident.js';

// notifications — alert engine (P1-8)
export * from './notifications/notification.js';

// real-time delivery — SSE stream frames (P2-2 G-5)
export * from './stream/stream.js';

// capability
export * from './capability/descriptor.js';

// config
export * from './config/hierarchy.js';

/** Contract package version — bump per Constitution §7 (semver; breaking = major + ADR). */
export const CONTRACTS_VERSION = '0.1.0';
