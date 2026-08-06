/**
 * **Soak profiles** — the workload a platform soak runs, as configuration.
 *
 * `platform-soak.mjs` measures the platform. This file says what to point it at. A new capability
 * gets a soak by adding an object here; it never gets one by copying the harness.
 *
 * ### ⚠️ A profile that cannot run says so, loudly, and refuses
 *
 * Most capabilities on the roadmap need a primitive the platform does not have — count aggregation,
 * line geometry, absence, or a model that emits a non-person class. The tempting shape is a profile
 * that runs anyway and measures whatever happens.
 *
 * That shape is exactly the defect this repository keeps finding: **a capability that is configurable
 * and unverified**. Camera-scoped rules were enablable in the contract and unusable in every
 * deployment for four milestones because nothing had tried (L-56). A Crowd Counting soak that ran
 * green against a rule that can never fire would be the same defect with a nightly stage attached.
 *
 * So every profile carries `status`. A profile whose status is not `available` **refuses to run** and
 * names the primitive it is waiting for. When that primitive ships, the milestone that ships it flips
 * one field and inherits a six-hour stability verification it did not have to write.
 *
 * ### The contract a profile must satisfy
 *
 * ```
 * id                  kebab-case, stable, used on the command line
 * title               what a person calls it
 * status              'available' | 'blocked'
 * blockedBy           REQUIRED when status is 'blocked' — the primitive, in one sentence
 * requires            the platform primitives this profile exercises, for the record
 * cameras             how many to create
 * fixture(i)          which RTSP fixture path camera i streams
 * zones(ctx)          detection zones to create — [] if the profile needs none
 * rules(ctx)          rules to create and enable
 * expect              per-profile thresholds layered ON TOP of the platform-wide ones
 * ```
 *
 * `ctx` carries `{ cameraIds, zoneIds, tag }` so a rule can name what setup produced.
 */

/** The whole frame. Geometry is not what a soak measures — `zone-geometry.test.ts` does that. */
export const WHOLE_FRAME = {
  points: [
    [0.02, 0.02],
    [0.98, 0.02],
    [0.98, 0.98],
    [0.02, 0.98],
  ],
};

/**
 * ⚠️ **60 seconds, and the reason is L-57.** The events service collapses repeated detections of one
 * subject into one event per dedup bucket (~10 s), so a dwell threshold under about 20 s measures the
 * platform's own sampling as much as the workload. A soak that used 15 s would produce a red that
 * looked like a broken dwell stage.
 */
const DWELL_SECONDS = 60;

/**
 * ⚠️ **300 s, the template default, not the 0 s the end-to-end run uses.** A 0 s cool-down is right
 * for a six-minute verification that needs to see a repeat inside its window. Over seven hours it is
 * an incident flood — and an incident flood is not incident throughput, it is a self-inflicted load
 * test with the rule engine as its victim.
 */
const COOLDOWN_SECONDS = 300;

/** Present in every rule: a dwell rule with no identity to accumulate against can never fire. */
const HAS_IDENTITY = { field: 'subjects.0.identityId', op: 'exists' };

export const PROFILES = [
  {
    id: 'retail-loitering',
    title: 'Retail Loitering',
    status: 'available',
    requires: ['detection-zone', 'scope', 'condition', 'dwell', 'identity'],
    cameras: 4,
    fixture: (i) => `walk${((i - 1) % 2) + 1}`,
    zones: () => [{ name: 'whole frame', kind: 'area', shape: 'polygon', geometry: WHOLE_FRAME }],
    rules: ({ cameraIds, zoneIds }) => [
      {
        name: 'dwell',
        eventTypes: ['perception.person.detected'],
        condition: HAS_IDENTITY,
        dwell: {
          minSeconds: DWELL_SECONDS,
          groupBy: 'identity',
          resetAfterSeconds: 15,
          cooldownSeconds: COOLDOWN_SECONDS,
        },
        dryRun: false,
        severity: 'low',
        actions: [{ type: 'raise-incident' }],
        scope: { nodeIds: [], cameraIds: [cameraIds[0]], groupIds: [], zoneIds },
      },
    ],
    expect: { minDetectionsPerFrame: 0.5, maxDropRatePercent: 5 },
  },

  {
    id: 'restricted-zone',
    title: 'Restricted Zone',
    status: 'available',
    requires: ['detection-zone', 'scope', 'condition', 'dwell', 'identity'],
    /*
     * ⚠️ The same engine, a shorter clock and a different word. That is the platform's central claim
     * (VERTICALS.md §1) and running it as its own soak profile is what keeps the claim falsifiable —
     * if restricted-zone ever needs a ninth hop, this profile is where it shows up.
     */
    cameras: 4,
    fixture: (i) => `walk${((i - 1) % 2) + 1}`,
    zones: () => [
      { name: 'restricted area', kind: 'area', shape: 'polygon', geometry: WHOLE_FRAME },
    ],
    rules: ({ cameraIds, zoneIds }) => [
      {
        name: 'presence',
        eventTypes: ['perception.person.detected'],
        condition: HAS_IDENTITY,
        dwell: {
          minSeconds: 30,
          groupBy: 'identity',
          resetAfterSeconds: 15,
          cooldownSeconds: COOLDOWN_SECONDS,
        },
        dryRun: false,
        severity: 'medium',
        actions: [{ type: 'raise-incident' }],
        scope: { nodeIds: [], cameraIds: [cameraIds[0]], groupIds: [], zoneIds },
      },
    ],
    expect: { minDetectionsPerFrame: 0.5, maxDropRatePercent: 5 },
  },

  {
    id: 'baseline',
    title: 'Perception baseline (no rules)',
    status: 'available',
    requires: ['assignment', 'inference', 'tracking', 'identity', 'event-bridge'],
    /*
     * The control profile. Frames, tracking, identity and the event bridge, with no rule engine
     * involvement at all — so a drift seen here and in a capability profile is a perception drift,
     * and one seen only in the capability profile belongs to the rule.
     */
    cameras: 4,
    fixture: (i) => `walk${((i - 1) % 2) + 1}`,
    zones: () => [],
    rules: () => [],
    expect: { minDetectionsPerFrame: 0.5, maxDropRatePercent: 5 },
  },

  /* ── Blocked. Each names the primitive it is waiting for, and refuses to run until it exists. ── */

  {
    id: 'crowd-counting',
    title: 'Crowd Counting',
    status: 'blocked',
    blockedBy:
      'count aggregation — distinct subjects in a zone at an instant. `window` counts EVENTS, so two ' +
      'events from one person read as two people. See PHASE_8_PLAN §4.2 and VERTICALS §4 gap 1.',
    requires: ['detection-zone', 'count-aggregation'],
    cameras: 4,
    fixture: (i) => `walk${((i - 1) % 2) + 1}`,
    zones: () => [{ name: 'counted area', kind: 'area', shape: 'polygon', geometry: WHOLE_FRAME }],
    rules: () => [],
    expect: { minDetectionsPerFrame: 0.5, maxDropRatePercent: 5 },
  },

  {
    id: 'occupancy',
    title: 'Occupancy',
    status: 'blocked',
    blockedBy:
      'count aggregation, plus a scene with a KNOWN number of people. ⚠️ A count over a ' +
      'dedup-collapsed stream is "distinct subject keys observed in the last bucket", not "people ' +
      'present" — the two diverge exactly when a customer cares. The primitive must state which it ' +
      'reports before this profile can assert anything.',
    requires: ['detection-zone', 'count-aggregation'],
    cameras: 4,
    fixture: (i) => `walk${((i - 1) % 2) + 1}`,
    zones: () => [{ name: 'occupied area', kind: 'area', shape: 'polygon', geometry: WHOLE_FRAME }],
    rules: () => [],
    expect: { minDetectionsPerFrame: 0.5, maxDropRatePercent: 5 },
  },

  {
    id: 'theft-detection',
    title: 'Theft Detection',
    status: 'blocked',
    blockedBy:
      'correlation across rules and across cameras — and ⚠️ it is EXCLUDED by the Architect, twice. ' +
      'Theft is an inference about intent assembled from weak signals; the platform can supply the ' +
      "signals and the accusation is not the platform's to make (VERTICALS §5).",
    requires: ['cross-rule-correlation', 'cross-camera-identity'],
    cameras: 4,
    fixture: (i) => `walk${((i - 1) % 2) + 1}`,
    zones: () => [],
    rules: () => [],
    expect: {},
  },

  {
    id: 'hospital',
    title: 'Hospital',
    status: 'blocked',
    blockedBy:
      'unauthorised entry is expressible today and would duplicate `restricted-zone`; everything ' +
      'that makes this vertical distinct is not. Bed-exit needs ABSENCE (an inversion the ' +
      'event-driven engine cannot express), corridor congestion needs count, and patient wandering ' +
      'needs cross-camera identity, which is research. ⚠️ Clinical-safety and consent duties are ' +
      "the customer's and are not addressed by the platform.",
    requires: ['absence', 'count-aggregation', 'cross-camera-identity'],
    cameras: 4,
    fixture: (i) => `walk${((i - 1) % 2) + 1}`,
    zones: () => [],
    rules: () => [],
    expect: {},
  },

  {
    id: 'warehouse',
    title: 'Warehouse',
    status: 'blocked',
    blockedBy:
      'restricted aisle and loading-bay dwell are `restricted-zone` and `retail-loitering` with ' +
      'different numbers — running them again measures nothing new. Dock occupancy needs count; ' +
      'abandoned object and vehicle movement need a model emitting a non-person class.',
    requires: ['count-aggregation', 'non-person-classes'],
    cameras: 4,
    fixture: (i) => `walk${((i - 1) % 2) + 1}`,
    zones: () => [],
    rules: () => [],
    expect: {},
  },

  {
    id: 'factory',
    title: 'Factory',
    status: 'blocked',
    blockedBy:
      'PPE and forklift safety need a model emitting a helmet/vest attribute or a forklift class — ' +
      'model work, not platform work. ⚠️ Machine-guard breach IS expressible and deliberately has ' +
      'no profile: a video pipeline with in-memory state and a documented restart gap (L-59) must ' +
      'never be the only thing between a person and a machine, and a green soak would read as ' +
      'evidence that it can be.',
    requires: ['non-person-classes', 'attributes'],
    cameras: 4,
    fixture: (i) => `walk${((i - 1) % 2) + 1}`,
    zones: () => [],
    rules: () => [],
    expect: {},
  },
];

export function lookupProfile(id) {
  return PROFILES.find((p) => p.id === id);
}

export function listProfiles() {
  return PROFILES.map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    blockedBy: p.blockedBy,
  }));
}
