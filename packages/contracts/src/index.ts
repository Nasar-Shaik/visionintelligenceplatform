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

// events
export * from './events/priority.js';
export * from './events/envelope.js';
export * from './events/catalog.js';

// capability
export * from './capability/descriptor.js';

// config
export * from './config/hierarchy.js';

/** Contract package version — bump per Constitution §7 (semver; breaking = major + ADR). */
export const CONTRACTS_VERSION = '0.1.0';
