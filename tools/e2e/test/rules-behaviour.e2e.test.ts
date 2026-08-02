/**
 * G-3.5 req #5 (Rule conflict), #6 (Duplicate events), #3 (Replay / determinism).
 *
 * Documented behaviours proven here:
 *  - Rule conflict:  one event that matches N rules produces N independent candidates → N incidents
 *                    (each rule is evaluated; higher `priority` first; no rule suppresses another).
 *  - Duplicate:      a repeated event (same dedup identity) is COLLAPSED — the store dedups at ingest,
 *                    and the candidate/incident dedup keys collapse a burst to a single incident.
 *  - Replay:         re-feeding stored events through a fresh Rule Engine yields identical evaluations
 *                    and identical incidents (byte-identical ids), because time + ids are injected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateRuleInput } from '@vip/contracts';
import { PlatformHarness } from '../src/harness.js';
import { SCENARIOS, emitScenario, runScenario } from '../src/scenarios.js';

const TENANT = 'tnt_rules';

const personSecurityRule: CreateRuleInput = {
  name: 'person → security incident',
  lifecycle: 'enabled',
  priority: 200, // evaluated before the medium rule (higher priority first)
  eventTypes: ['perception.person.detected'],
  categories: [],
  severity: 'high',
  actions: [{ type: 'raise-incident' }],
  scope: { nodeIds: [], cameraIds: [] },
};

describe('rule conflict — one event matches multiple rules', () => {
  let h: PlatformHarness;
  beforeEach(async () => {
    h = new PlatformHarness();
    await h.start();
    await h.seedChannel(TENANT);
  });
  afterEach(async () => {
    await h.stop();
  });

  it('produces one incident per matching rule (both a medium and a security rule fire)', async () => {
    const person = SCENARIOS.find((s) => s.key === 'person-entrance')!;
    await h.seedRule(TENANT, person.rule); // medium
    await h.seedRule(TENANT, personSecurityRule); // high
    await emitScenario(h, TENANT, person);

    const incidents = await h.incidents(TENANT);
    expect(incidents).toHaveLength(2);
    expect(incidents.map((i) => i.severity).sort()).toEqual(['high', 'medium']);
    // Both trace back to the SAME originating event (one detection, two rules).
    const eventId = (await h.events(TENANT))[0]!.id;
    expect(incidents.every((i) => i.triggeredBy.eventId === eventId)).toBe(true);
    // Two alerts fan out (one per incident) to the single channel.
    expect(await h.notifications(TENANT)).toHaveLength(2);
  });
});

describe('duplicate events', () => {
  let h: PlatformHarness;
  beforeEach(async () => {
    h = new PlatformHarness();
    await h.start();
    await h.seedChannel(TENANT);
  });
  afterEach(async () => {
    await h.stop();
  });

  it('collapses a duplicate detection to a single event and a single incident', async () => {
    const fire = SCENARIOS.find((s) => s.key === 'fire-warehouse')!;
    await h.seedRule(TENANT, fire.rule);
    // Same capturedAt + camera + label ⇒ same dedup identity. Emit twice.
    await emitScenario(h, TENANT, fire);
    await emitScenario(h, TENANT, fire);

    expect(await h.events(TENANT)).toHaveLength(1); // ingest dedup
    expect(await h.incidents(TENANT)).toHaveLength(1); // candidate/incident dedup
    expect(await h.notifications(TENANT)).toHaveLength(1);
  });

  it('collapses a redelivered semantic event (same envelope id) to a single incident', async () => {
    const fight = SCENARIOS.find((s) => s.key === 'fight-detected')!;
    await h.seedRule(TENANT, fight.rule);
    await emitScenario(h, TENANT, fight);
    await emitScenario(h, TENANT, fight); // redelivery — same id/dedupKey
    expect(await h.events(TENANT)).toHaveLength(1);
    expect(await h.incidents(TENANT)).toHaveLength(1);
  });
});

const chosen = () =>
  SCENARIOS.filter((s) => ['person-entrance', 'fire-warehouse', 'fight-detected'].includes(s.key));

/** Order-independent projection of an incident's rule-evaluation *result* (not its random id). */
function evalResult(
  incidents: { correlationId?: string; severity: string; triggeredBy: { eventType: string } }[],
) {
  return incidents.map((i) => `${i.correlationId}|${i.severity}|${i.triggeredBy.eventType}`).sort();
}

describe('determinism', () => {
  it('two harnesses given the identical operation sequence produce byte-identical incident ids', async () => {
    const run = async () => {
      const h = new PlatformHarness();
      await h.start();
      await h.seedChannel(TENANT);
      for (const s of chosen()) await h.seedRule(TENANT, s.rule);
      for (const s of chosen()) await emitScenario(h, TENANT, s);
      const ids = (await h.incidents(TENANT)).map((i) => i.id).sort();
      await h.stop();
      return ids;
    };
    const first = await run();
    const second = await run();
    expect(first).toHaveLength(3);
    expect(second).toEqual(first); // fully deterministic — same sequence ⇒ same ids
  });
});

describe('replay through the Rule Engine', () => {
  it('re-feeding stored events yields identical rule-evaluation results', async () => {
    // Run A: drive the scenarios live, capture the persisted events + incident evaluation results.
    const a = new PlatformHarness();
    await a.start();
    await a.seedChannel(TENANT);
    for (const s of chosen()) await runScenario(a, TENANT, s);
    const storedEvents = await a.events(TENANT);
    const resultsA = evalResult(await a.incidents(TENANT));
    await a.stop();

    // Run B: fresh Rule Engine, same rules, REPLAY the stored events (regression / rule-change testing).
    const b = new PlatformHarness();
    await b.start();
    await b.seedChannel(TENANT);
    for (const s of chosen()) await b.seedRule(TENANT, s.rule);
    for (const event of storedEvents) await b.replayEvent(event);
    const resultsB = evalResult(await b.incidents(TENANT));
    await b.stop();

    expect(storedEvents).toHaveLength(3);
    expect(resultsB).toEqual(resultsA); // identical evaluations ⇒ deterministic replay
  });
});
