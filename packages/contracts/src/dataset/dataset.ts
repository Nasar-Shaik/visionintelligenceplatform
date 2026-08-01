/**
 * CCTV dataset + accuracy-evaluation contracts (AI-5e, Architect priorities 1 & 3). These describe
 * **recorded surveillance footage and what the platform is expected to see in it** — the evidence
 * that moves a capability from "runs" to "works", which no amount of simulation can supply.
 *
 * Governance shapes only: no runtime behavior depends on them and the five frozen perception
 * contracts are untouched. The runtime mirrors these in ai/inference/dataset.py + evaluation.py.
 *
 * **Footage bytes never live in git.** A `DatasetCase` is a manifest — it points at footage held in
 * DVC/object storage (ai/datasets/README.md) and records consent/licence for it, because surveillance
 * footage of real people is exactly the kind of data that must not be casually copied around.
 */
import { z } from 'zod';
import { IsoDateTime, SemVer } from '../common/primitives.js';
import { EvidenceClass } from '../certification/certification.js';

/**
 * The scenario a dataset case exercises. This is the Architect's AI-5e priority-1 list, and it is
 * deliberately a **closed enum**: an open string would let cases accumulate under seven spellings of
 * "loitering" and quietly stop being a regression suite. New scenarios are added additively here.
 */
export const ScenarioCategory = z.enum([
  'person_detection',
  'tracking',
  'queue',
  'crowd',
  'loitering',
  'intrusion',
  'restricted_area',
  'shoplifting',
  'cashier_theft',
  'suspicious_behavior',
  'fire',
  'smoke',
  'violence',
  'abandoned_object',
  'fall_detection',
  'ppe',
  'customer_movement',
  'staff_movement',
]);
export type ScenarioCategory = z.infer<typeof ScenarioCategory>;

/**
 * Where the footage actually is, and whether we are allowed to have it. `path` is repo-relative and
 * resolves to a DVC-tracked file; `sha256` pins the exact bytes so an evaluation result can never be
 * attributed to footage that has since been replaced.
 */
export const FootageReference = z.object({
  /** Repo-relative path under ai/datasets/. The bytes are DVC-tracked, not committed. */
  path: z.string().min(1).max(500),
  /** Digest of the footage. When present it is verified before evaluation — results pin to bytes. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex sha256')
    .optional(),
  durationSeconds: z.number().positive().optional(),
  fps: z.number().positive().optional(),
  resolution: z
    .string()
    .regex(/^\d{2,5}x\d{2,5}$/, 'must be WIDTHxHEIGHT')
    .optional(),
  /** Where it came from: `public-dataset`, `synthetic`, `customer-pilot`, `internal-capture`. */
  origin: z.enum(['public-dataset', 'synthetic', 'customer-pilot', 'internal-capture']),
  /** Licence or consent basis. Required — footage of real people without a recorded basis is not usable. */
  licence: z.string().min(1).max(200),
  /** Anonymisation applied (face blur, plate blur, …), when any. */
  anonymisation: z.string().max(500).optional(),
});
export type FootageReference = z.infer<typeof FootageReference>;

/**
 * One thing the platform is expected to produce from the footage, with the window it is expected in.
 * Expectations are **temporal and countable, not pixel-exact**: the platform's job is to notice that
 * someone loitered near the counter between 0:12 and 0:31, and holding it to a bounding-box IoU it was
 * never labelled for would make the suite expensive to maintain and dishonest about what it proves.
 */
export const ExpectedOccurrence = z.object({
  /** What kind of output this expects. */
  kind: z.enum(['detection', 'track', 'behavior', 'composite', 'event', 'incident']),
  /** Label / behaviorType / eventType, e.g. `person`, `loitering`, `security.intrusion.detected`. */
  type: z.string().min(1).max(120),
  /** Expected count, when the case is about how many. */
  count: z.number().int().nonnegative().optional(),
  /** Inclusive tolerance on `count` — real footage does not produce exact numbers. */
  countTolerance: z.number().int().nonnegative().default(0),
  /** Window (seconds from footage start) the occurrence is expected within. */
  fromSeconds: z.number().nonnegative().optional(),
  toSeconds: z.number().nonnegative().optional(),
  /** Zone the occurrence is expected in, when the case defines zones. */
  zoneId: z.string().max(120).optional(),
  /** Minimum confidence the platform should report. */
  minConfidence: z.number().min(0).max(1).optional(),
  /**
   * A **negative** expectation: this must NOT occur. False positives are the failure mode that
   * loses customer trust in surveillance analytics, so the suite has to be able to assert their
   * absence as directly as it asserts a presence.
   */
  absent: z.boolean().default(false),
  notes: z.string().max(500).optional(),
});
export type ExpectedOccurrence = z.infer<typeof ExpectedOccurrence>;

/**
 * A single evaluable piece of footage plus what it should produce. This is the unit of the CCTV
 * dataset library and the unit of accuracy regression.
 */
export const DatasetCase = z.object({
  /** Stable slug, e.g. `loitering/entrance-dwell-01`. */
  id: z.string().min(1).max(200),
  category: ScenarioCategory,
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  footage: FootageReference,
  /** Zones the case defines, in the generic zone-config shape the analyzer already consumes. */
  zones: z.array(z.record(z.string(), z.unknown())).default([]),
  /** BehaviorProfile name to run the case under, when it needs one. */
  profile: z.string().max(120).optional(),
  /** Analyzer options for the run (confidence, tracking, behavior thresholds). */
  options: z.record(z.string(), z.unknown()).default({}),
  expectations: z.array(ExpectedOccurrence).default([]),
  /** Free-form notes: what makes this clip hard, what a human sees in it. */
  notes: z.string().max(2000).optional(),
  /** Known gaps — recorded so the suite documents its own limits instead of hiding them. */
  futureImprovements: z.array(z.string().max(300)).default([]),
  addedAt: IsoDateTime.optional(),
});
export type DatasetCase = z.infer<typeof DatasetCase>;

/** How one expectation actually turned out. */
export const EvaluationOutcome = z.enum([
  /** Produced as expected, within tolerance. */
  'match',
  /** Expected but never produced — a false negative. */
  'missing',
  /** Asserted absent but produced anyway — a false positive. */
  'unexpected',
  /** Produced, but the count/timing/confidence fell outside tolerance. */
  'out-of-tolerance',
  /**
   * Recorded but not judged by this evaluator. A `DatasetCase` describes what the WHOLE PLATFORM
   * should make of a clip, including the incident a rule would raise — but the AI runtime emits
   * events, not incidents, and scoring itself against an output it does not own would be meaningless
   * in both directions. Deferred findings are reported and excluded from precision/recall.
   */
  'deferred',
]);
export type EvaluationOutcome = z.infer<typeof EvaluationOutcome>;

/** One expectation, judged. */
export const EvaluationFinding = z.object({
  kind: ExpectedOccurrence.shape.kind,
  type: z.string().min(1).max(120),
  outcome: EvaluationOutcome,
  expectedCount: z.number().int().nonnegative().optional(),
  observedCount: z.number().int().nonnegative().default(0),
  /** When timing mattered: the window asserted, and when it actually happened. */
  window: z.string().max(60).optional(),
  observedAtSeconds: z.number().nonnegative().optional(),
  detail: z.string().max(1000).optional(),
});
export type EvaluationFinding = z.infer<typeof EvaluationFinding>;

/**
 * Status of an evaluation run. **`footage-missing` is its own status and is never a pass** — the
 * dataset library must not turn into a suite that reports green because it evaluated nothing. It is
 * the expected status in CI, where the DVC bytes are not pulled.
 */
export const EvaluationStatus = z.enum(['pass', 'fail', 'footage-missing', 'error']);
export type EvaluationStatus = z.infer<typeof EvaluationStatus>;

/** The result of running one `DatasetCase` through the pipeline. */
export const EvaluationReport = z.object({
  id: z.string().min(1),
  caseId: z.string().min(1).max(200),
  category: ScenarioCategory,
  status: EvaluationStatus,
  runtimeVersion: SemVer,
  /** Model/engine the case ran under — accuracy claims are meaningless without it. */
  model: z.string().max(200).optional(),
  engine: z.string().max(60).optional(),
  findings: z.array(EvaluationFinding).default([]),
  truePositives: z.number().int().nonnegative().default(0),
  falseNegatives: z.number().int().nonnegative().default(0),
  falsePositives: z.number().int().nonnegative().default(0),
  /** tp / (tp + fp); null when nothing was produced or expected. */
  precision: z.number().min(0).max(1).nullable().default(null),
  /** tp / (tp + fn); null when nothing was expected. */
  recall: z.number().min(0).max(1).nullable().default(null),
  f1: z.number().min(0).max(1).nullable().default(null),
  framesProcessed: z.number().int().nonnegative().default(0),
  durationSeconds: z.number().nonnegative().default(0),
  /** `recorded-footage` for a real clip; `simulated` for a synthetic one. Never `hardware`. */
  evidenceClass: EvidenceClass,
  recordedAt: IsoDateTime,
  notes: z.string().max(2000).optional(),
});
export type EvaluationReport = z.infer<typeof EvaluationReport>;

/**
 * The aggregate across a dataset run — what a regression gate reads. `regressed` names the cases that
 * got worse against the accepted accuracy baseline, which is the only number that should block a merge.
 */
export const EvaluationSummary = z.object({
  id: z.string().min(1),
  runtimeVersion: SemVer,
  cases: z.number().int().nonnegative().default(0),
  passed: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
  /** Cases whose footage was not available locally — reported, never counted as passing. */
  skipped: z.number().int().nonnegative().default(0),
  truePositives: z.number().int().nonnegative().default(0),
  falseNegatives: z.number().int().nonnegative().default(0),
  falsePositives: z.number().int().nonnegative().default(0),
  precision: z.number().min(0).max(1).nullable().default(null),
  recall: z.number().min(0).max(1).nullable().default(null),
  f1: z.number().min(0).max(1).nullable().default(null),
  /** Per-category rollup, so a regression can be attributed to a scenario. */
  byCategory: z.record(z.string(), z.record(z.string(), z.number())).default({}),
  /** Case ids that scored worse than the accepted baseline. */
  regressed: z.array(z.string().min(1)).default([]),
  /** Case ids that scored better. */
  improved: z.array(z.string().min(1)).default([]),
  /** Overall gate: no failures and no regressions. Skipped cases do not make this true. */
  accepted: z.boolean().default(false),
  evidenceClass: EvidenceClass,
  recordedAt: IsoDateTime,
});
export type EvaluationSummary = z.infer<typeof EvaluationSummary>;
