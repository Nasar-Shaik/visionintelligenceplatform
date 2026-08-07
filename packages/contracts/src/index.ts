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
// the platform's one evidence vocabulary — shared by certification (AI-5e) and the camera lifecycle (P-2)
export * from './common/evidence.js';
export * from './common/foundations.js';

// tenant + org hierarchy (P1-1)
export * from './tenant/tenant.js';
export * from './tenant/branding.js';

// auth: users, tokens, principal (P1-2)
export * from './auth/auth.js';

// camera inventory (P1-3)
export * from './camera/camera.js';
// P-5.4 rec 5 — camera placement and the camera map. Additive; camera.ts is untouched.
export * from './camera/placement.js';

// camera processing assignment — the platform control plane (P-8 Phase 6). Decides which cameras
// consume AI, on which runtime, under which profile. Additive: no frozen contract is touched.
export * from './assignment/assignment.js';

// media / ingestion (P1-4)
export * from './media/media.js';
// offline video investigation — an uploaded recording analysed by the LIVE pipeline (P-8 Phase 8).
// ⚠️ `AnalysisSession` is the Media context's execution record; it is NOT the AI runtime's live
// session (`POST /sessions`). Two words, two meanings — see the header, and ADR-0044's discipline.
export * from './media/analysis.js';
export * from './media/analysis-timeline.js';

// evidence (P2-2 G-4)
export * from './evidence/evidence.js';
// P-5.4.1 rec 1 — derived artefacts: source, profile, ordered operations, renderer version, hash.
export * from './evidence/derived.js';

// perception / inference (P1-6)
export * from './perception/perception.js';

// tracking + zones (AI-2)
export * from './tracking/tracking.js';

// detection zones — named polygons on a camera's image plane (P-8 Phase 7). ⚠️ NOT location-hierarchy
// zones; see the table at the top of zones/zone.ts and ADR-0044.
export * from './zones/zone.js';

// behavior analysis (AI-3)
export * from './behavior/behavior.js';

// benchmarking + performance governance (AI-5a)
export * from './benchmark/benchmark.js';

// production certification: evidence, compatibility, soak, maturity promotion (AI-5e)
export * from './certification/certification.js';

// CCTV dataset library + accuracy evaluation (AI-5e)
export * from './dataset/dataset.js';

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
// rule templates — the reference workflow as configuration (P-8 Phase 7)
export * from './rules/templates.js';

// incidents — workflow lifecycle (P1-8)
export * from './incidents/incident.js';
export * from './incidents/chain.js';
// P-5.4 rec 10 — investigation metrics, derived on read.
export * from './incidents/metrics.js';

// notifications — alert engine (P1-8)
export * from './notifications/notification.js';

// real-time delivery — SSE stream frames (P2-2 G-5)
export * from './stream/stream.js';

// ---------------------------------------------------------------------------------------------
// P-5.2.0 — the Investigation Workspace prerequisites. Every contract below is **frozen and
// unimplemented**: shapes settled before code, so the workspace slice consumes them rather than
// inventing them. Nothing in the platform reads or writes these yet.
// ---------------------------------------------------------------------------------------------

// unified search — federated over existing indexed query surfaces (rec 6). Exported before the
// workspace, which imports `SearchEntityKind`.
export * from './search/search.js';

// investigation workspace: layout register, command + keyboard registry, UI state, saved work
export * from './workspace/workspace.js';
export * from './workspace/commands.js';
export * from './workspace/state.js';
export * from './workspace/saved.js';
export * from './workspace/extensions.js';
export * from './workspace/health.js';
export * from './workspace/surfaces.js';

// platform health (P-6.4) — the deployment's view of itself. ⚠️ Exported after `workspace/health`,
// whose state enum it aliases rather than duplicates.
export * from './platform/health.js';

// playback — recorded CCTV review (rec 2)
export * from './playback/playback.js';
export * from './playback/viewer.js';
// P-5.4 rec 1 — the operator's playback session, held as UI state.
export * from './playback/session.js';
// P-5.4 rec 4 — the annotation layer, and redaction as a rendered derivative.
export * from './playback/annotation.js';

// background jobs — anything too slow to hold a request open (rec 4)
export * from './jobs/job.js';

// report model — one shape every generator consumes (rec 5)
export * from './reporting/report.js';
// P-5.4 rec 3 — export profiles. Presentation only.
export * from './reporting/profiles.js';

// access audit — read-side only; writes stay derived (rec 7)
export * from './audit/access.js';

// capability
export * from './capability/descriptor.js';

// config
export * from './config/hierarchy.js';

/** Contract package version — bump per Constitution §7 (semver; breaking = major + ADR). */
export const CONTRACTS_VERSION = '0.1.0';
