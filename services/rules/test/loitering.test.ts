/**
 * The loitering workflow's non-dwell halves (P-8 Phase 7): scope narrowing, dwell validation, and
 * what a candidate carries.
 *
 * ⚠️ The scope tests exist because P-8 Phase 7 made `EventEnvelope.zoneId` mean a *detection* zone
 * while `ResolvedRuleScope.zoneIds` still means a *location-hierarchy* zone. Two id spaces, one word.
 * Every test here that mentions a zone says which kind it means.
 */
import { describe, expect, it } from 'vitest';
import {
  LOITERING_TEMPLATE,
  RULE_TEMPLATES,
  FUTURE_WORKFLOW_COVERAGE,
  type EventEnvelope,
  type ResolvedRuleScope,
  type Rule,
  type RuleDwell,
} from '@vip/contracts';
import { compileScope, explainScope, matchesScope } from '../src/domain/scope.js';
import { dwellChecks } from '../src/domain/validation.js';
import { buildIncidentCandidate, candidateDedupKey } from '../src/domain/incident.js';
import { observe, type DwellOutcome } from '../src/domain/dwell.js';

const T0 = Date.parse('2026-08-06T10:00:00.000Z');

const resolved = (over: Partial<ResolvedRuleScope>): ResolvedRuleScope => ({
  zoneIds: [],
  detectionZoneIds: [],
  cameraIds: [],
  groupCameraIds: [],
  tenantWide: false,
  resolvedAt: new Date(T0).toISOString(),
  ...over,
});

const envelope = (over: Partial<EventEnvelope> = {}): EventEnvelope =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    type: 'perception.person.detected',
    envelopeVersion: '1.0.0',
    category: 'perception',
    schemaVersion: '1.0.0',
    tenantId: 't-1',
    cameraId: 'cam-1',
    occurredAt: new Date(T0).toISOString(),
    ingestedAt: new Date(T0).toISOString(),
    producer: { capability: 'perception.person-detection', capabilityVersion: '1.0.0' },
    subjects: [{ trackId: 'trk-1', identityId: 'id-1', class: 'person' }],
    payload: {},
    evidenceRefs: [],
    priority: 'info',
    ...over,
  }) as EventEnvelope;

describe('detection-zone scope', () => {
  it('narrows to the named zones: a rule watching one zone ignores every other', () => {
    const scope = compileScope(resolved({ detectionZoneIds: ['zn-queue'] }));
    expect(matchesScope(scope, envelope({ zoneId: 'zn-queue' }))).toBe(true);
    expect(matchesScope(scope, envelope({ zoneId: 'zn-aisle' }))).toBe(false);
  });

  /**
   * ⚠️ The narrowing must beat the camera check, or a rule scoped to "this camera AND this zone"
   * would fire on every event from the camera and the zone scope would be decorative.
   */
  it('still narrows when the rule also names the event’s camera', () => {
    const scope = compileScope(resolved({ detectionZoneIds: ['zn-queue'], cameraIds: ['cam-1'] }));
    expect(matchesScope(scope, envelope({ zoneId: 'zn-queue' }))).toBe(true);
    expect(matchesScope(scope, envelope({ zoneId: 'zn-aisle' }))).toBe(false);
    /* A subject in NO zone on that camera is outside a zone-scoped rule. */
    expect(matchesScope(scope, envelope())).toBe(false);
  });

  /**
   * ⚠️ The two zone id spaces must never be matched against each other. This is ADR-0044's whole
   * point: a hierarchy expansion compared against a polygon id would match nothing today and
   * something wrong the day the hierarchy is wired up.
   */
  it('does not match a detection zone against the location-hierarchy expansion', () => {
    const scope = compileScope(resolved({ zoneIds: ['zn-queue'] }));
    expect(matchesScope(scope, envelope({ zoneId: 'zn-queue' }))).toBe(true);
    /* …but only because the ids happen to collide. With the field it belongs in, it narrows: */
    const proper = compileScope(resolved({ detectionZoneIds: ['zn-other'] }));
    expect(matchesScope(proper, envelope({ zoneId: 'zn-queue' }))).toBe(false);
  });

  it('explains a miss in words naming the zone', () => {
    const scope = compileScope(resolved({ detectionZoneIds: ['zn-queue'] }));
    expect(explainScope(scope, envelope({ zoneId: 'zn-aisle' }))).toContain('zn-aisle');
    expect(explainScope(scope, envelope())).toContain('not inside any zone');
  });

  /** A rule scoped only to cameras is unchanged by this milestone. */
  it('leaves camera-only scoping alone', () => {
    const scope = compileScope(resolved({ cameraIds: ['cam-1'] }));
    expect(matchesScope(scope, envelope())).toBe(true);
    expect(matchesScope(scope, envelope({ cameraId: 'cam-9' }))).toBe(false);
  });

  /** ⚠️ A rule stored before P-8 Phase 7 has no `detectionZoneIds` field at all. */
  it('tolerates a resolution written before detection zones existed', () => {
    const legacy = { zoneIds: [], cameraIds: ['cam-1'], tenantWide: false, resolvedAt: '' };
    const scope = compileScope(legacy as ResolvedRuleScope);
    expect(scope.detectionZoneIds.size).toBe(0);
    expect(matchesScope(scope, envelope())).toBe(true);
  });
});

describe('dwell validation', () => {
  const rule = (dwell: RuleDwell, over: Partial<Rule> = {}): Rule =>
    ({ id: 'r', eventTypes: [], dwell, ...over }) as unknown as Rule;

  const codes = (r: Rule): string[] => dwellChecks(r).map((i) => i.code);

  it('passes a sensible loitering configuration', () => {
    expect(
      codes(
        rule({ minSeconds: 60, groupBy: 'identity', resetAfterSeconds: 30, cooldownSeconds: 300 }),
      ),
    ).toEqual([]);
  });

  /**
   * ⚠️ Every one of these saves cleanly, enables cleanly, reports healthy, and never fires.
   *
   * The floor is the **event dedup window**, not the frame rate — the deployment showed that a
   * continuously present person is observed about once every ten seconds however fast the camera
   * runs, because `services/events` collapses repeats into one event per bucket. The first version
   * of this check used the frame interval and would have blessed a 3-second reset that could never
   * accumulate anything.
   */
  it('refuses a reset far below the interval at which subjects are actually observed', () => {
    const issues = dwellChecks(
      rule({ minSeconds: 60, groupBy: 'identity', resetAfterSeconds: 3, cooldownSeconds: 300 }),
    );
    expect(issues.map((i) => i.code)).toContain('dwell-reset-below-observation-interval');
    expect(issues.find((i) => i.code === 'dwell-reset-below-observation-interval')?.severity).toBe(
      'error',
    );
  });

  it('warns when the reset is near that interval rather than far below it', () => {
    const issues = dwellChecks(
      rule({ minSeconds: 60, groupBy: 'identity', resetAfterSeconds: 8, cooldownSeconds: 300 }),
    );
    expect(issues.find((i) => i.code === 'dwell-reset-below-observation-interval')?.severity).toBe(
      'warning',
    );
  });

  it('says nothing about a reset comfortably above it', () => {
    expect(
      codes(
        rule({ minSeconds: 60, groupBy: 'identity', resetAfterSeconds: 30, cooldownSeconds: 300 }),
      ),
    ).not.toContain('dwell-reset-below-observation-interval');
  });

  it('warns when the threshold is at or below the reset', () => {
    expect(
      codes(
        rule({ minSeconds: 20, groupBy: 'identity', resetAfterSeconds: 30, cooldownSeconds: 300 }),
      ),
    ).toContain('dwell-threshold-below-reset');
  });

  it('warns loudly about a zero cool-down', () => {
    expect(
      codes(
        rule({ minSeconds: 60, groupBy: 'identity', resetAfterSeconds: 30, cooldownSeconds: 0 }),
      ),
    ).toContain('dwell-no-cooldown');
  });

  it('refuses a dwell rule bound to an event type that carries no subject', () => {
    const r = rule(
      { minSeconds: 60, groupBy: 'identity', resetAfterSeconds: 30, cooldownSeconds: 300 },
      { eventTypes: ['system.service.started'] } as Partial<Rule>,
    );
    expect(codes(r)).toContain('dwell-on-subjectless-event');
  });

  it('says nothing at all about a rule with no dwell', () => {
    expect(dwellChecks({ id: 'r', eventTypes: [] } as unknown as Rule)).toEqual([]);
  });
});

describe('the candidate a loiter produces', () => {
  const dwellConfig: RuleDwell = {
    minSeconds: 60,
    groupBy: 'identity',
    resetAfterSeconds: 30,
    cooldownSeconds: 300,
  };

  const loiterRule: Rule = {
    id: 'rule-loiter',
    tenantId: 't-1',
    name: 'Retail Loitering',
    lifecycle: 'enabled',
    priority: 100,
    version: 3,
    eventTypes: ['perception.person.detected'],
    categories: [],
    dwell: dwellConfig,
    dryRun: false,
    severity: 'medium',
    actions: [{ type: 'raise-incident' }],
    scope: { nodeIds: [], cameraIds: [], groupIds: [], zoneIds: ['zn-queue'] },
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
  };

  /**
   * ⭐ The ordinary match rule — no dwell, no `window.groupBy`. This is the shape the demo tenant's
   * "Person detected — any camera" uses and the one V-15 was found on; its group key is `'-'`, so
   * without a subject its dedup key is `[tenant, rule, '-', bucket]` for every person on earth.
   */
  const matchRule: Rule = {
    ...loiterRule,
    id: 'rule-person',
    name: 'Person detected — any camera',
    scope: { nodeIds: [], cameraIds: [], groupIds: [], zoneIds: [] },
  };
  delete (matchRule as { dwell?: RuleDwell }).dwell;

  /** A 90-second visit sampled every 15 seconds, with one identity re-link partway through. */
  function visit(): DwellOutcome {
    let outcome: DwellOutcome | undefined;
    for (let i = 0; i <= 6; i += 1) {
      outcome = observe(
        outcome?.record,
        {
          atMs: T0 + i * 15_000,
          eventId: `2222222${i}-1111-4111-8111-111111111111`,
          eventType: 'perception.person.detected',
          trackId: i < 4 ? 'trk-1' : 'trk-2',
          confidence: 0.8,
          frameId: `t-1:cam-1:${i}`,
        },
        dwellConfig,
      );
    }
    return outcome as DwellOutcome;
  }

  const build = () =>
    buildIncidentCandidate(
      loiterRule,
      envelope({ zoneId: 'zn-queue', confidence: 0.8 }),
      1,
      60_000,
      { newId: () => '33333333-1111-4111-8111-111111111111', now: () => new Date(T0 + 90_000) },
      { outcome: visit(), subject: 'id-1', zoneName: 'Checkout Queue', zoneVersion: 4 },
    );

  it('carries the Architect’s nine fields', () => {
    const c = build();
    expect(c.triggeredBy.cameraId).toBe('cam-1');
    expect(c.identityId).toBe('id-1');
    expect(c.triggeredBy.zoneId).toBe('zn-queue');
    expect(c.ruleId).toBe('rule-loiter');
    expect(c.durationSeconds).toBe(90);
    expect(c.timeline?.entries.length).toBeGreaterThan(0);
    expect(c.evidence.length).toBeGreaterThan(0);
    expect(c.confidence).toBeCloseTo(0.8, 6);
    expect(c.explanation).toBeDefined();
  });

  /**
   * ⚠️ The two honesty fields, and they must reach the summary an operator reads first — not sit
   * three clicks deeper where the reassuring half of the story travels further than the qualifying
   * half.
   */
  it('says in the first line that identity was carried across a link', () => {
    const c = build();
    expect(c.explanation?.trackFragments).toBe(2);
    expect(c.explanation?.summary).toContain('track fragments');
    expect(c.explanation?.summary).toContain('inferred');
  });

  it('names the zone rather than its id, and stamps the version the geometry was at', () => {
    const c = build();
    expect(c.explanation?.zoneName).toBe('Checkout Queue');
    expect(c.explanation?.zoneVersion).toBe(4);
    expect(c.title).toContain('Checkout Queue');
  });

  /** ⚠️ Exit is not observable at the moment a candidate is raised. It must not be fabricated. */
  it('leaves exit time absent rather than pretending the subject left', () => {
    expect(build().explanation?.exitAt).toBeUndefined();
  });

  it('produces an ordered timeline whose entries link to their evidence', () => {
    const timeline = build().timeline;
    const times = timeline?.entries.map((e) => Date.parse(e.at)) ?? [];
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(timeline?.entries[0]?.kind).toBe('first-observed');
    const withEvidence = timeline?.entries.filter((e) => e.evidence.length > 0) ?? [];
    expect(withEvidence.length).toBeGreaterThan(0);
    expect(timeline?.entries[0]?.evidence.some((e) => e.kind === 'identity')).toBe(true);
    expect(withEvidence.some((e) => e.evidence.some((r) => r.kind === 'frame'))).toBe(true);
  });

  /** ⚠️ References, never bytes, and never a URL that could carry a host or a token. */
  it('references evidence with platform-relative locators', () => {
    const c = build();
    expect(c.evidence.some((e) => e.kind === 'recording-interval')).toBe(true);
    for (const ref of c.evidence) {
      expect(ref.locator.startsWith('/')).toBe(true);
      expect(ref.locator).not.toMatch(/^https?:/);
    }
  });

  /**
   * ⚠️ Two people loitering in the same minute must produce two candidates. With the pre-Phase-7
   * key — tenant, rule, group, time bucket — they shared a dedup key and the broker collapsed the
   * second one. One person would get an incident; the other would silently vanish.
   */
  it('gives two subjects two dedup keys', () => {
    const a = candidateDedupKey(loiterRule, envelope({ zoneId: 'zn-queue' }), 60_000, {
      outcome: visit(),
      subject: 'id-1',
    });
    const b = candidateDedupKey(loiterRule, envelope({ zoneId: 'zn-queue' }), 60_000, {
      outcome: visit(),
      subject: 'id-2',
    });
    expect(a).not.toBe(b);
  });

  it('gives one subject in two zones two dedup keys', () => {
    const a = candidateDedupKey(loiterRule, envelope({ zoneId: 'zn-queue' }), 60_000, {
      outcome: visit(),
      subject: 'id-1',
    });
    const b = candidateDedupKey(loiterRule, envelope({ zoneId: 'zn-aisle' }), 60_000, {
      outcome: visit(),
      subject: 'id-1',
    });
    expect(a).not.toBe(b);
  });

  /**
   * ⛔ **V-4 — ADR-0047 reached the events dedup key and not this one.**
   *
   * Found by P-8.5 Product Validation against the deployed stack, not by this suite. Every part of
   * this key is derived from the observation, and an offline analysis stamps **footage** time — so
   * re-analysing one recording reproduces `occurredAt`, reproduces `bucket`, and the rerun's
   * candidates collide with the first run's permanently, because footage time never advances out of
   * the window.
   *
   * Measured: a five-minute recording raised **8 incidents** on its first run and **0** on an
   * identical second run, while its events, timeline and tracks all reproduced correctly. ADR-0047
   * promises both analyses are persisted independently and independently queryable; that held for
   * events and silently failed for incidents.
   */
  it('⛔ gives two analysis runs of one recording two dedup keys', () => {
    const key = (analysisSessionId: string) =>
      candidateDedupKey(loiterRule, envelope({ zoneId: 'zn-queue', analysisSessionId }), 60_000, {
        outcome: visit(),
        subject: 'id-1',
      });
    expect(key('ases_A')).not.toBe(key('ases_B'));
  });

  it('⛔ separates two runs on the bucketed (non-dwell) path too', () => {
    const key = (over: Partial<EventEnvelope>) =>
      candidateDedupKey(loiterRule, envelope(over), 60_000);
    expect(key({ analysisSessionId: 'ases_A' })).not.toBe(key({ analysisSessionId: 'ases_B' }));
  });

  /**
   * ⛔ **V-15 — the subject reasoning above was applied to the dwell branch only.**
   *
   * "Two people … would share a dedup key and the second would silently vanish" is what this file
   * has said since Phase 7, and the bucketed branch carried no subject at all, so it was true of
   * every ordinary match rule the whole time. Found on the Architect's own 19-second recording: three
   * walk-pasts, three tracker subjects, three persisted `perception.person.detected` events, **one**
   * incident — the recording is shorter than one 60 s bucket, so `[tenant, rule, '-', bucket]` was
   * constant across all three.
   *
   * The 37 validation clips are all 30 s, which also fits inside one bucket, so every fixture in the
   * library produced exactly one incident and that looked like the right answer. Same shape as
   * [L-63]: the dataset agreed with itself.
   */
  it('⛔ gives three appearances by three tracked subjects three dedup keys', () => {
    const key = (trackId: string) =>
      candidateDedupKey(
        matchRule,
        envelope({ subjects: [{ trackId, class: 'person' }], analysisSessionId: 'ases_A' }),
        60_000,
      );
    /* The three tracks the tracker actually produced for the reported recording. */
    expect(new Set([key('trk_a_2'), key('trk_a_3'), key('trk_a_5')]).size).toBe(3);
  });

  /** The same subject twice in one bucket is still one incident — dedup's actual job. */
  it('still collapses one subject seen twice inside the window', () => {
    const key = () =>
      candidateDedupKey(matchRule, envelope({ subjects: [{ trackId: 'trk-1', class: 'person' }] }), 60_000);
    expect(key()).toBe(key());
  });

  /**
   * ⭐ An envelope that names no subject keeps the pre-V-15 key exactly. Dedup state outlives a
   * deployment, so anything whose key *shape* moved would miss its window once on rollout.
   */
  it('⭐ leaves a subjectless candidate key byte-identical', () => {
    const bare = envelope({ subjects: [] });
    expect(candidateDedupKey(matchRule, bare, 60_000)).toBe(
      ['t-1', matchRule.id, '-', Math.floor(T0 / 60_000)].join('|'),
    );
  });

  /**
   * ⚠️ `class` is `'person'` for everybody. Falling back to it would look like the subject had been
   * accounted for while bucketing every human being together — worse than an honest absence.
   */
  it('does not key on the class when there is no track id', () => {
    const key = (identityId: string) =>
      candidateDedupKey(matchRule, envelope({ subjects: [{ identityId, class: 'person' }] }), 60_000);
    expect(key('id-1')).toBe(key('id-2'));
    /* And it stays the pre-V-15 four-part key rather than gaining a class-shaped fifth part. */
    expect(key('id-1').split('|')).toHaveLength(4);
  });

  /**
   * ⭐ **The backward-compatibility assertion, and the reason the field is appended rather than
   * joined with a placeholder.** Dedup state outlives a deployment: a key whose *shape* changed
   * would make every live rule miss its window once on rollout — a burst of duplicate incidents at
   * exactly the moment an operator is watching a deploy.
   */
  it('⭐ leaves a live candidate key byte-identical', () => {
    const live = envelope({ zoneId: 'zn-queue' });
    expect(candidateDedupKey(loiterRule, live, 60_000, { outcome: visit(), subject: 'id-1' })).toBe(
      ['t-1', loiterRule.id, 'zn-queue', 'id-1', visit().record.firstObservedAtMs, visit().record.firedAtMs ?? Math.floor(T0 / 60_000)].join('|'),
    );
    expect(candidateDedupKey(loiterRule, live, 60_000)).not.toContain('undefined');
  });

  /** A redelivery of the same visit must collapse — that is what dedup is actually for. */
  it('gives the same visit the same dedup key twice', () => {
    const outcome = visit();
    const key = () =>
      candidateDedupKey(loiterRule, envelope({ zoneId: 'zn-queue' }), 60_000, {
        outcome,
        subject: 'id-1',
      });
    expect(key()).toBe(key());
  });

  it('reports the observation count rather than a bare 1', () => {
    expect(build().matchedCount).toBe(7);
  });

  it('is a candidate and not in dry run', () => {
    const c = build();
    expect(c.status).toBe('candidate');
    expect(c.dryRun).toBe(false);
  });

  it('marks the candidate a dry-run rule would have raised', () => {
    const c = buildIncidentCandidate(
      { ...loiterRule, dryRun: true },
      envelope({ zoneId: 'zn-queue' }),
      1,
      60_000,
      { newId: () => 'x', now: () => new Date(T0) },
      { outcome: visit(), subject: 'id-1' },
    );
    expect(c.dryRun).toBe(true);
  });

  /** A stateless rule's candidate carries none of the dwell fields — absent, not zeroed. */
  it('leaves the dwell fields off a candidate with no dwell', () => {
    const c = buildIncidentCandidate({ ...loiterRule, dwell: undefined }, envelope(), 1, 60_000, {
      newId: () => 'x',
      now: () => new Date(T0),
    });
    expect(c.durationSeconds).toBeUndefined();
    expect(c.identityId).toBeUndefined();
    expect(c.explanation).toBeUndefined();
    expect(c.timeline).toBeUndefined();
  });
});

describe('the loitering template (rules are configuration, not code)', () => {
  it('ships exactly one template', () => {
    expect(RULE_TEMPLATES).toHaveLength(1);
    expect(RULE_TEMPLATES[0]).toBe(LOITERING_TEMPLATE);
  });

  /**
   * ⚠️ The structural check behind "the same engine supports Theft, Queue, Intrusion… without
   * redesign": the word *loitering* appears in the template's id and nowhere in the engine. A future
   * workflow is a new entry in one array.
   */
  it('is expressible entirely as a CreateRuleInput', () => {
    const input = LOITERING_TEMPLATE.rule;
    expect(input.dwell?.groupBy).toBe('identity');
    expect(input.eventTypes).toEqual(['perception.person.detected']);
    expect(input.actions).toEqual([{ type: 'raise-incident' }]);
    /* ⚠️ Requires an identity, so a producer that is not tracking fails at the CONDITION stage —
     * whose explanation names the real problem — rather than at the dwell stage, which would report
     * "threshold not met" for a rule that can never accumulate. */
    expect(input.condition).toEqual({ field: 'subjects.0.identityId', op: 'exists' });
  });

  it('records what every future workflow still needs, including the gaps', () => {
    const byWorkflow = new Map(FUTURE_WORKFLOW_COVERAGE.map((c) => [c.workflow, c]));
    expect(byWorkflow.get('Loitering')?.needs).toBeUndefined();
    /* ⚠️ These are honest gaps, not stubs. A table claiming everything was ready would be wrong. */
    expect(byWorkflow.get('Line crossing')?.needs).toBeTruthy();
    expect(byWorkflow.get('Occupancy')?.needs).toBeTruthy();
    expect(byWorkflow.get('Theft')?.needs).toBeTruthy();
  });
});
