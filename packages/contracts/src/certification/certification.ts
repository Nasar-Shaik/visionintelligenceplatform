/**
 * Production certification contracts (AI-5e). These are **governance** shapes — they record what was
 * measured, on what, and with what kind of evidence. They add no runtime behavior, no perception
 * capability and no new architectural layer; the five frozen AI Runtime v1.0 contracts
 * (DetectionResult/Track/BehaviorResult/CompositeBehavior/EventEnvelope) are untouched (ED-0039/40).
 *
 * **The load-bearing idea of this file is `EvidenceClass`.** Everything the platform has proved so
 * far was proved in simulation, and simulation proves architecture, not production readiness. So
 * every check, every report and every promotion carries the class of evidence it rests on, and the
 * rule that a device is not certified and a capability is not `production` without `hardware`
 * evidence is expressed *in the shapes themselves* rather than in a paragraph someone has to
 * remember. A framework that can quietly certify itself from its own simulations is worse than no
 * framework, because it converts an unknown into a false assurance.
 *
 * Grounds: docs/architecture/future/PRODUCTION_COMPATIBILITY.md §3 (certification matrix),
 * CAPABILITY_MATURITY.md §4 (promotion criteria); mirrored by ai/inference/certification.py.
 */
import { z } from 'zod';
import { IsoDateTime, SemVer } from '../common/primitives.js';
import { CameraCapabilities, CameraMetadata } from '../camera/camera.js';
import {
  BenchmarkReport,
  DeploymentClass,
  EnvironmentFingerprint,
} from '../benchmark/benchmark.js';

/**
 * What a result was actually observed on. Ordered weakest → strongest, and that order is the whole
 * point: a report is only as strong as its weakest check, and certification requires `hardware`.
 *
 * - `simulated` — deterministic simulated sources + stub adapters. Proves the plumbing.
 * - `recorded-footage` — real CCTV footage through the real pipeline. Proves perception, not devices.
 * - `hardware` — a physical camera/DVR/NVR/GPU/edge device. The only class that certifies.
 */
export const EvidenceClass = z.enum(['simulated', 'recorded-footage', 'hardware']);
export type EvidenceClass = z.infer<typeof EvidenceClass>;

/**
 * Certification status of a device/target. **`pending-validation` is the default and stays the
 * default until a physical device has been tested** — the platform makes no hardware compatibility
 * claim it has not measured (Architect AI-5e, deliverable 4).
 */
export const CertificationStatus = z.enum([
  /** No physical device has been tested. The honest default for every row of the matrix. */
  'pending-validation',
  /** A physical run is underway; results are partial. */
  'in-validation',
  /** Measured on real hardware, every mandatory check passed. */
  'certified',
  /** Measured on real hardware, at least one mandatory check failed. */
  'failed',
  /** Measured and found incompatible in a way no configuration fixes. */
  'not-supported',
]);
export type CertificationStatus = z.infer<typeof CertificationStatus>;

/** Outcome of one certification check. `not-executed` is distinct from `skipped`: the first means the
 * harness never got to it (a prior failure), the second means it did not apply to this target. Neither
 * is ever silently treated as a pass. */
export const CheckStatus = z.enum(['pass', 'fail', 'warn', 'skipped', 'not-executed']);
export type CheckStatus = z.infer<typeof CheckStatus>;

/**
 * One deterministic certification check. Shaped like `CameraValidationCheck` (P2-2 G-1) on purpose —
 * an operator reading either sees the same thing — but adds the measurement and the evidence class,
 * because a certification check that cannot say what it measured is an opinion.
 */
export const CertificationCheck = z.object({
  /** Stable machine name, e.g. `connect`, `sub-stream-selected`, `credential-redaction`. */
  name: z.string().min(1).max(100),
  status: CheckStatus,
  /** Human explanation — required for anything that is not a plain pass. */
  detail: z.string().max(1000).optional(),
  /** What was measured, when the check is quantitative. */
  measured: z.number().optional(),
  /** The threshold it was measured against. */
  expected: z.number().optional(),
  unit: z.string().max(20).optional(),
  /** Whether failing this check blocks certification. Informational checks record, they do not gate. */
  mandatory: z.boolean().default(true),
  evidenceClass: EvidenceClass,
});
export type CertificationCheck = z.infer<typeof CertificationCheck>;

/**
 * What class of estate a target represents. DVRs and NVRs are first-class here because most customers
 * already own one and will not replace it to buy software (PRODUCTION_COMPATIBILITY §2).
 */
export const TargetKind = z.enum(['camera', 'dvr', 'nvr', 'encoder', 'edge-device', 'recording']);
export type TargetKind = z.infer<typeof TargetKind>;

/**
 * The identity of a certification target. Reuses `CameraMetadata` for the device fields so a
 * registry entry, a camera record and a certification report all describe a device the same way.
 */
export const CertificationTarget = z.object({
  /** Stable slug, e.g. `hikvision-ds2cd2143g2`, `generic-onvif`, `recorded-mp4`. */
  id: z.string().min(1).max(120),
  /** Human label for the matrix row. */
  label: z.string().min(1).max(200),
  device: CameraMetadata,
  /** Declared transport(s) exercised: `rtsp`, `onvif`, `usb`, `http`, `file`, … */
  transports: z.array(z.string().min(1).max(20)).default([]),
  /** Capabilities as discovered/declared at the time of the run. */
  capabilities: CameraCapabilities.optional(),
  /** DVR/NVR/camera/edge — what class of estate this row represents. */
  kind: TargetKind.default('camera'),
});
export type CertificationTarget = z.infer<typeof CertificationTarget>;

/**
 * Does the runtime work with this device at all — connect, stream, reconnect, redact, shut down
 * cleanly. Answers "can we ingest from it", never "does it detect correctly" (that is `CapabilityReport`).
 */
export const CompatibilityReport = z.object({
  id: z.string().min(1),
  target: CertificationTarget,
  runtimeVersion: SemVer,
  checks: z.array(CertificationCheck).default([]),
  /** AND of every mandatory check. `pending-validation` while evidence is not `hardware`. */
  status: CertificationStatus,
  /** The weakest evidence class across all checks — a report is never stronger than its weakest check. */
  evidenceClass: EvidenceClass,
  /** Stream profile the runtime chose to analyze, and why — the cheapest performance decision there is. */
  selectedProfile: z.string().max(100).optional(),
  environment: EnvironmentFingerprint.optional(),
  recordedAt: IsoDateTime,
  notes: z.string().max(2000).optional(),
});
export type CompatibilityReport = z.infer<typeof CompatibilityReport>;

/** What one perception capability was observed to do on this target. */
export const CapabilityObservation = z.object({
  capabilityId: z.string().min(1).max(120),
  /** Event type the capability emits, when it emits one. */
  eventType: z.string().max(120).optional(),
  /** Maturity claimed *before* this run — the report is the evidence for changing it, not the change. */
  maturity: z.enum(['experimental', 'beta', 'production', 'deprecated']),
  /** Whether the capability produced output at all during the run. */
  exercised: z.boolean().default(false),
  detections: z.number().int().nonnegative().default(0),
  behaviors: z.number().int().nonnegative().default(0),
  events: z.number().int().nonnegative().default(0),
  checks: z.array(CertificationCheck).default([]),
  evidenceClass: EvidenceClass,
});
export type CapabilityObservation = z.infer<typeof CapabilityObservation>;

/** Which capabilities were exercised on this target, and what they produced. */
export const CapabilityReport = z.object({
  id: z.string().min(1),
  targetId: z.string().min(1).max(120),
  runtimeVersion: SemVer,
  observations: z.array(CapabilityObservation).default([]),
  evidenceClass: EvidenceClass,
  recordedAt: IsoDateTime,
  notes: z.string().max(2000).optional(),
});
export type CapabilityReport = z.infer<typeof CapabilityReport>;

/**
 * How a measurement moved between the start and the end of a long run. **Drift, not level, is what a
 * soak test is for**: a runtime that starts at 40 MB and ends at 40 MB is fine; one that starts at
 * 40 MB and ends at 900 MB will fail in the field on a Tuesday night three weeks after handover.
 */
export const DriftMeasurement = z.object({
  metric: z.string().min(1).max(60),
  unit: z.string().max(20).optional(),
  first: z.number(),
  last: z.number(),
  min: z.number(),
  max: z.number(),
  /** last − first. */
  drift: z.number(),
  /** Percentage change relative to `first`; 0 when `first` is 0. */
  driftPercent: z.number(),
  /** Ceiling this drift was judged against, when one applied. */
  toleratedPercent: z.number().nonnegative().optional(),
  status: CheckStatus,
});
export type DriftMeasurement = z.infer<typeof DriftMeasurement>;

/**
 * A long-duration continuous run (6/12/24/48/72h). No capability is promoted without one, because
 * every failure mode that matters in surveillance is a slow one.
 */
export const SoakReport = z.object({
  id: z.string().min(1),
  targetId: z.string().min(1).max(120),
  runtimeVersion: SemVer,
  /** Planned duration; `actualHours` may be shorter when the run aborted. */
  plannedHours: z.number().positive(),
  actualHours: z.number().nonnegative(),
  /** Samples taken across the run — drift is derived from these. */
  samples: z.number().int().nonnegative().default(0),
  drift: z.array(DriftMeasurement).default([]),
  /** Operational counters accumulated over the run. */
  recoveries: z.number().int().nonnegative().default(0),
  restarts: z.number().int().nonnegative().default(0),
  reconnects: z.number().int().nonnegative().default(0),
  degradations: z.number().int().nonnegative().default(0),
  framesProcessed: z.number().int().nonnegative().default(0),
  droppedFramePercent: z.number().min(0).max(100).default(0),
  /** Health score at the start and end, and the lowest it reached. */
  healthFirst: z.number().min(0).max(100).optional(),
  healthLast: z.number().min(0).max(100).optional(),
  healthMin: z.number().min(0).max(100).optional(),
  /** Health score trend across the run, for the sparkline. */
  healthTrend: z.array(z.number().min(0).max(100)).default([]),
  /** Whether the run completed its planned duration with every drift within tolerance. */
  passed: z.boolean().default(false),
  /** Why it did not pass, when it did not. */
  blockers: z.array(z.string().max(300)).default([]),
  evidenceClass: EvidenceClass,
  environment: EnvironmentFingerprint.optional(),
  startedAt: IsoDateTime,
  recordedAt: IsoDateTime,
});
export type SoakReport = z.infer<typeof SoakReport>;

/**
 * The one-page verdict for a target: the reports that were produced, whether they add up to a
 * certification, and — when they do not — exactly what is missing. `blockers` is the field that makes
 * this useful: "pending-validation" without a reason is a shrug.
 */
export const CertificationSummary = z.object({
  id: z.string().min(1),
  target: CertificationTarget,
  runtimeVersion: SemVer,
  /** Version of the certification procedure itself, so results stay comparable as it evolves. */
  certificationVersion: SemVer.default('1.0.0'),
  deploymentClass: DeploymentClass.optional(),
  compatibilityId: z.string().min(1).optional(),
  capabilityId: z.string().min(1).optional(),
  soakId: z.string().min(1).optional(),
  benchmarkIds: z.array(z.string().min(1)).default([]),
  status: CertificationStatus,
  /** The weakest evidence class across every constituent report. */
  evidenceClass: EvidenceClass,
  /** Everything standing between this target and `certified`. Empty only when certified. */
  blockers: z.array(z.string().max(300)).default([]),
  checksPassed: z.number().int().nonnegative().default(0),
  checksFailed: z.number().int().nonnegative().default(0),
  checksTotal: z.number().int().nonnegative().default(0),
  environment: EnvironmentFingerprint.optional(),
  recordedAt: IsoDateTime,
});
export type CertificationSummary = z.infer<typeof CertificationSummary>;

/**
 * The customer validation package (Architect AI-5e, deliverable 8) — one reusable bundle a customer
 * returns after a pilot. Everything needed to reason about a deployment without asking them a single
 * follow-up question, and nothing that could carry a credential.
 */
export const CertificationBundle = z.object({
  id: z.string().min(1),
  bundleVersion: SemVer.default('1.0.0'),
  runtimeVersion: SemVer,
  generatedAt: IsoDateTime,
  /** Deployment/site label the customer recognises. */
  site: z.string().max(200).optional(),
  environment: EnvironmentFingerprint.optional(),
  summary: CertificationSummary,
  compatibility: CompatibilityReport.optional(),
  capability: CapabilityReport.optional(),
  soak: SoakReport.optional(),
  benchmarks: z.array(BenchmarkReport).default([]),
  /** Redacted runtime configuration — credentials are referenced, never included. */
  configuration: z.record(z.string(), z.unknown()).default({}),
  /** Health summary at bundle time (component scores + trend). */
  health: z.record(z.string(), z.unknown()).optional(),
  /** Recovery/failure analytics over the pilot. */
  recovery: z.record(z.string(), z.unknown()).optional(),
  /** Operational log excerpt — already redacted by the journal that produced it. */
  logs: z.array(z.string().max(2000)).default([]),
  notes: z.string().max(4000).optional(),
});
export type CertificationBundle = z.infer<typeof CertificationBundle>;

/**
 * A permanent record of a device the platform has met (Architect AI-5e, recommendation 1). This
 * accumulates value in a way nothing else here does: the fifth Hikvision deployment should cost a
 * fraction of the first, and that only happens if the first one wrote down what it learned.
 */
export const CameraRegistryEntry = z.object({
  /** Stable slug — matches `CertificationTarget.id`. */
  id: z.string().min(1).max(120),
  manufacturer: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  /** Firmware versions this entry has been observed on. */
  firmware: z.array(z.string().max(100)).default([]),
  kind: TargetKind.default('camera'),
  transports: z.array(z.string().min(1).max(20)).default([]),
  onvif: z.boolean().default(false),
  /** Streams the device publishes, as discovered. */
  streamProfiles: CameraCapabilities.shape.streamProfiles.optional(),
  /** Vendor quirks worth knowing before the next deployment. Free text on purpose. */
  knownIssues: z.array(z.string().max(500)).default([]),
  /** Settings that were found to work — sub-stream name, fps clamp, transport flags. */
  recommendedSettings: z.record(z.string(), z.unknown()).default({}),
  status: CertificationStatus,
  /** Procedure version the certification was granted under. */
  certificationVersion: SemVer.optional(),
  certifiedAt: IsoDateTime.optional(),
  /** Ids of the reports backing the status. Empty for `pending-validation`. */
  evidence: z.array(z.string().min(1)).default([]),
  evidenceClass: EvidenceClass.default('simulated'),
  updatedAt: IsoDateTime,
  notes: z.string().max(2000).optional(),
});
export type CameraRegistryEntry = z.infer<typeof CameraRegistryEntry>;

// ---------------------------------------------------------------------------
// Capability maturity promotion (Architect AI-5e, deliverable 7)
// ---------------------------------------------------------------------------

/** The maturity ladder from CAPABILITY_MATURITY §1. Metadata — no runtime behavior depends on it. */
export const MaturityLevel = z.enum(['experimental', 'beta', 'production', 'deprecated']);
export type MaturityLevel = z.infer<typeof MaturityLevel>;

/**
 * The evidence a promotion rests on. Every field is a report **id**, not a claim: a promotion request
 * that cannot name its evidence is refused, which is the entire mechanism by which "maturity is never
 * edited manually" becomes true rather than aspirational.
 */
export const MaturityEvidence = z.object({
  benchmarkReportId: z.string().min(1).optional(),
  compatibilityReportId: z.string().min(1).optional(),
  capabilityReportId: z.string().min(1).optional(),
  soakReportId: z.string().min(1).optional(),
  certificationSummaryId: z.string().min(1).optional(),
  /** Ids of dataset evaluations backing accuracy claims (see ../dataset/dataset.ts). */
  evaluationReportIds: z.array(z.string().min(1)).default([]),
  /** Weakest class across the cited evidence. `production` requires `hardware`. */
  evidenceClass: EvidenceClass,
});
export type MaturityEvidence = z.infer<typeof MaturityEvidence>;

/** The outcome of asking for a promotion. Refusal is the common case and carries its reasons. */
export const MaturityPromotion = z.object({
  capabilityId: z.string().min(1).max(120),
  from: MaturityLevel,
  to: MaturityLevel,
  granted: z.boolean(),
  evidence: MaturityEvidence,
  /** What was missing. Empty only when granted. */
  blockers: z.array(z.string().max(300)).default([]),
  decidedAt: IsoDateTime,
  notes: z.string().max(1000).optional(),
});
export type MaturityPromotion = z.infer<typeof MaturityPromotion>;

// ---------------------------------------------------------------------------
// Hardware sizing (Architect AI-5e, recommendation 2)
// ---------------------------------------------------------------------------

/**
 * A deployment sizing recommendation. **Derived from measured benchmark capacity, never guessed** —
 * `basis` names the benchmark report the arithmetic came from, and a recommendation with no basis is
 * explicitly marked as an estimate so nobody quotes it to a customer as a measurement.
 */
export const HardwareRecommendation = z.object({
  /** Deployment profile the sizing was requested for (retail-store, factory-floor, …). */
  profile: z.string().min(1).max(120),
  cameras: z.number().int().positive(),
  targetFps: z.number().positive(),
  /** Behaviors/composites enabled — the AI workload, which is what actually drives cost. */
  workload: z.array(z.string().min(1).max(60)).default([]),
  recommendedClass: DeploymentClass,
  /** Compute capacity the workload needs, in the runtime's abstract units. */
  requiredCapacityUnits: z.number().nonnegative(),
  /** Capacity the recommended class provides. */
  availableCapacityUnits: z.number().nonnegative(),
  /** Spare capacity as a percentage of what the class provides — never recommend a box at 100%. */
  headroomPercent: z.number(),
  cpuCores: z.number().int().positive().optional(),
  memoryGb: z.number().positive().optional(),
  gpu: z.string().max(200).optional(),
  /** Whether the recommendation fits at all; false means every class was exceeded. */
  feasible: z.boolean().default(true),
  /** Benchmark report id the per-camera cost was measured from. Absent → `estimated` is true. */
  basis: z.string().min(1).optional(),
  /** True when no measured basis existed and the numbers come from documented defaults. */
  estimated: z.boolean().default(true),
  rationale: z.string().max(1000).optional(),
});
export type HardwareRecommendation = z.infer<typeof HardwareRecommendation>;
